// @ts-nocheck
/**
 * @dsh-external/dsh-vista-plugin — DSH 侧 VISTA 物理级视觉探针插件
 *
 * 核心能力：
 * 1. 自动唤醒与自愈 (Auto-Wakeup & Watchdog)：
 *    探活 127.0.0.1:8765/health；若未启动，使用 wsl.exe 自动在后台拉起 WSL2 与 VISTA 守护进程。
 * 2. 双模自适应通信 (Hybrid Dispatcher)：
 *    优先直连 HTTP 守护进程（毫秒级高响应），若 HTTP 不可用自动降级为单次 stdio 命令行进程调用。
 * 3. 4 个标准视觉原语：
 *    - vista_play: 会话载入与执行交互
 *    - vista_inspect: 局部区域物理无损放大与证据切片
 *    - vista_read_pixels: 离散色彩采样与精确像素矩阵读取
 *    - vista_history: 审计历史与操作追踪
 * 4. 自动识图意图引导：
 *    通过 ctx.systemPrompt.context 注入探针指导，使 DSH 模型遇到图片或多模态任务时自动调用 VISTA。
 */

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_VERSION = '1.0.1'
const DEFAULT_PORT = 8765
const HOSTNAME = '127.0.0.1'
const ANY_SCHEMA = { type: 'json' }

/**
 * lossless-JSON 消毒器：
 * 防止 undefined / NaN / ±Infinity / -0 破坏宿主工具返回值校验。
 */
function losslessSanitize(root) {
  const fixes = []
  const seen = new Set()
  const walk = (v, at) => {
    if (v === null) return null
    const t = typeof v
    if (t === 'string' || t === 'boolean') return v
    if (t === 'number') {
      if (!Number.isFinite(v)) { fixes.push(at + '=' + String(v) + '->null'); return null }
      if (Object.is(v, -0)) { fixes.push(at + '=-0->0'); return 0 }
      return v
    }
    if (t === 'undefined') { fixes.push(at + '=undefined->drop'); return undefined }
    if (t === 'bigint') {
      const n = Number(v)
      fixes.push(at + '=bigint->' + (Number.isSafeInteger(n) ? 'number' : 'string'))
      return Number.isSafeInteger(n) ? n : String(v)
    }
    if (t === 'function' || t === 'symbol') { fixes.push(at + '=' + t + '->drop'); return undefined }
    if (seen.has(v)) { fixes.push(at + '=circular->[Circular]'); return '[Circular]' }
    seen.add(v)
    let out
    if (Array.isArray(v)) {
      out = []
      for (let i = 0; i < v.length; i++) {
        const w = walk(v[i], at + '[' + String(i) + ']')
        out.push(w === undefined ? null : w)
      }
    } else if (v instanceof Date) {
      out = Number.isFinite(v.getTime()) ? v.toISOString() : null
    } else if (typeof v === 'object') {
      out = {}
      for (const k of Object.keys(v)) {
        const w = walk(v[k], at + '.' + k)
        if (w !== undefined) out[k] = w
      }
    } else {
      out = String(v)
    }
    return out
  }
  const value = walk(root, '$')
  return { value, fixes }
}

/** 动态导入 schemastery 与 defineTool */
let defineToolFn = null
try {
  const toolsMod = await import('@deepseek-ai/dsh-tools').catch(() => null)
  if (toolsMod && typeof toolsMod.defineTool === 'function') {
    defineToolFn = toolsMod.defineTool
  }
} catch (e) { /* fallback */ }

if (!defineToolFn) {
  try {
    const req = createRequire(import.meta.url)
    const toolsMod = req('@deepseek-ai/dsh-tools')
    if (toolsMod && typeof toolsMod.defineTool === 'function') {
      defineToolFn = toolsMod.defineTool
    }
  } catch (e) { /* fallback */ }
}

/** DSH 工具结果渲染器（将切片转换为 DSH UI 原生图文展示块） */
function renderOutput(_args, value) {
  const blocks = []
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && item.type === 'text') {
        blocks.push({ type: 'text', text: String(item.text || '') })
      } else if (item && item.type === 'image') {
        if (item.attachment) {
          blocks.push({ type: 'image', attachment: item.attachment })
        } else {
          blocks.push({ type: 'text', text: `[VISTA 图像切片已生成: ${item.mimeType || 'image/png'}]` })
        }
      } else {
        blocks.push({ type: 'text', text: typeof item === 'string' ? item : JSON.stringify(item, null, 2) })
      }
    }
  } else if (value && typeof value === 'object') {
    if (value.text) blocks.push({ type: 'text', text: String(value.text) })
    if (value.image && value.image.attachment) blocks.push({ type: 'image', attachment: value.image.attachment })
    if (blocks.length === 0) {
      blocks.push({ type: 'text', text: JSON.stringify(value, null, 2) })
    }
  } else {
    blocks.push({ type: 'text', text: String(value ?? '') })
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '(empty result)' }]
}

/** 将 Base64 图像保存至宿主附件系统 */
async function toAttachment(ctx, data, name) {
  try {
    const attachments = ctx?.get?.('attachments') || ctx?.attachments
    if (!attachments || typeof attachments.saveImage !== 'function') return null
    const ref = await attachments.saveImage({ data, mediaType: 'image/png', name })
    return {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name !== undefined ? { name: ref.name } : {})
    }
  } catch (e) {
    return null
  }
}

/** 包装并创建符合 DSH 规范的 Tool 对象 */
function wrapTool(spec) {
  const output = spec.output || {
    schema: ANY_SCHEMA,
    render: renderOutput
  }
  const wrapped = {
    ...spec,
    description: `[v${PLUGIN_VERSION}] ${spec.description || ''}`,
    output,
    isConcurrencySafe: () => true,
    timeoutMs: spec.timeoutMs || 60000,
    execute: async (args, exec) => {
      try {
        const raw = await spec.execute(args, exec)
        const { value } = losslessSanitize(raw)
        return value
      } catch (err) {
        return {
          ok: false,
          error: String(err && err.message ? err.message : err)
        }
      }
    }
  }
  if (defineToolFn) {
    try {
      return defineToolFn(wrapped)
    } catch (e) {
      console.warn(`[dsh-vista] defineTool 异常 (${spec.name}):`, e.message)
      return wrapped
    }
  }
  return wrapped
}

export const name = '@dsh-external/dsh-vista-plugin'
export const inject = ['tools', 'systemPrompt', 'attachments']

let childDaemon = null
let paused = false

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 探测 HTTP 守护进程健康状况 */
async function probeHealth(port, timeoutMs = 1500) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(`http://${HOSTNAME}:${port}/health`, { signal: ac.signal })
    return res.ok
  } catch (e) {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** 自动拉起 WSL2 中的 VISTA 守护进程 */
function startWslDaemon() {
  try {
    const p = spawn('wsl.exe', [
      '-d', 'Ubuntu',
      '-u', 'devcontainers',
      '--',
      'bash',
      '/mnt/h/AI/VISTA_Tool/scripts/start_vista_daemon.sh'
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    p.unref()
    childDaemon = p
    return true
  } catch (err) {
    console.error('[dsh-vista] 唤醒 WSL2 守护进程失败:', err)
    return false
  }
}

/** 确保 VISTA 后端已就绪（自动唤醒） */
async function ensureBackend(port) {
  if (await probeHealth(port, 1000)) return true
  console.log('[dsh-vista] 检测到 VISTA 守护进程未启动，正在唤醒 WSL2 后端...')
  startWslDaemon()
  for (let i = 0; i < 8; i++) {
    await sleep(500)
    if (await probeHealth(port, 1000)) {
      console.log('[dsh-vista] VISTA 守护进程已成功上线！')
      return true
    }
  }
  console.warn('[dsh-vista] 守护进程等待超时，将使用 stdio 降级模式。')
  return false
}

/**
 * 双模调用分发器：优先 HTTP，降级走 stdio invoke.py
 */
async function dispatchVistaTool(ctx, toolName, args, port = DEFAULT_PORT) {
  let result = null

  // 1. 尝试 HTTP 快速通道
  const isHttpUp = await probeHealth(port, 800)
  if (isHttpUp) {
    try {
      const res = await fetch(`http://${HOSTNAME}:${port}/api/call_tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: toolName, arguments: args || {} })
      })
      if (res.ok) {
        const json = await res.json()
        result = json.result !== undefined ? json.result : json
      }
    } catch (e) {
      console.warn(`[dsh-vista] HTTP 调用失败，回退到 stdio: ${e.message}`)
    }
  }

  // 2. 降级走 stdio 命令行通道
  if (!result) {
    try {
      const rawArgs = JSON.stringify(args || {})
      const proc = spawnSync('wsl.exe', [
        '-d', 'Ubuntu',
        '-u', 'devcontainers',
        '--',
        '/home/devcontainers/.venv/vista/bin/python',
        '/mnt/h/AI/VISTA_Tool/src/vista_mcp/invoke.py',
        toolName,
        rawArgs
      ], {
        encoding: 'utf8',
        timeout: 30000,
        windowsHide: true
      })

      if (proc.error) throw proc.error
      const stdout = (proc.stdout || '').trim()
      const jsonStart = stdout.indexOf('{')
      if (jsonStart >= 0) {
        const parsed = JSON.parse(stdout.slice(jsonStart))
        if (parsed.ok) {
          result = parsed.result
        } else {
          throw new Error(parsed.error || 'VISTA stdio 报错')
        }
      } else {
        throw new Error('stdio 未返回合法 JSON: ' + stdout)
      }
    } catch (err) {
      return {
        error: `VISTA 调用失败 (${toolName}): ${err.message}`,
        hint: '请确认 WSL2 已安装且 /home/devcontainers/.venv/vista Python 环境正常。'
      }
    }
  }

  // 3. 增强处理：若返回包含图像数据，尝试保存为 DSH 宿主原生附件
  if (Array.isArray(result)) {
    for (const it of result) {
      if (it && it.type === 'image' && it.data && typeof it.data === 'string') {
        const buf = Buffer.from(it.data, 'base64')
        const att = await toAttachment(ctx, buf, `vista_crop_${Date.now()}.png`)
        if (att) {
          it.attachment = att
        }
      }
    }
  }

  return result
}

/** Cordis 插件入口 */
export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const port = Number.isFinite(Number(cfg.port)) && Number(cfg.port) > 0 ? Number(cfg.port) : DEFAULT_PORT
  const autoStart = cfg.autoStart !== undefined ? !!cfg.autoStart : true

  // 1. 初始化拉起与看护
  if (autoStart && !paused) {
    void ensureBackend(port)
  }

  // 2. 注入全局 System Prompt（实现自动识图引导）
  if (ctx.systemPrompt && typeof ctx.systemPrompt.context === 'function') {
    try {
      ctx.systemPrompt.context({
        name: 'dsh-vista-plugin',
        order: -80,
        text: '本系统已搭载 VISTA 物理级高精视觉探针（vista_play、vista_inspect、vista_read_pixels、vista_history）。'
          + '【核心原则】：在面对游戏截图、复杂UI、图表、微小文字、血量进度槽时，严禁仅凭低分辨率全局图像猜想或脑补细节！'
          + '必须优先调用 vista_inspect 对关键细节执行无损局部物理切片放大，或调用 vista_read_pixels 进行精确像素值测量，用物理证据支持推理。'
      })
    } catch (e) {
      // 容忍重复注册
    }
  }

  // 3. 注册 4 个标准 VISTA 原语

  // [1/4] vista_play
  ctx.effect(() => ctx.tools.register(wrapTool({
    name: 'vista_play',
    description: '【VISTA 交互载入】在视觉任务中执行动作或载入新图像。传入 image_path 即可载入本地图像到无损帧存储。',
    parameters: {
      image_path: { type: 'string', description: '待分析的本地图像绝对路径（支持 Windows 或 WSL 路径，如 H:/AI/...）' },
      action: { type: 'string', description: '操作动作代码（例如 ACTION1..ACTION7，或 RESET）' },
      task_name: { type: 'string', description: '任务或游戏名称（默认 open_discovery）' },
      x: { type: 'integer', description: '点击坐标 X' },
      y: { type: 'integer', description: '点击坐标 Y' },
      session_id: { type: 'string', description: '会话 ID（可选）' }
    },
    output: {
      schema: ANY_SCHEMA,
      render: renderOutput
    },
    isConcurrencySafe: () => true,
    timeoutMs: 60000,
    async execute(args) {
      if (args && args.image_path) {
        return await dispatchVistaTool(ctx, 'vista_load_image', {
          image_path: args.image_path,
          task_name: args.task_name || 'open_discovery',
          session_id: args.session_id
        }, port)
      }
      return await dispatchVistaTool(ctx, 'vista_play', args || {}, port)
    }
  })))

  // [2/4] vista_inspect
  ctx.effect(() => ctx.tools.register(wrapTool({
    name: 'vista_inspect',
    description: '【VISTA 物理级无损放大探查】对指定历史帧的局部区域进行物理无损切片放大，消除视觉幻觉并返回高清晰度切片证据图。不改变环境状态。',
    parameters: {
      views: {
        type: 'json',
        description: '待切片的视图列表，数组格式：[{"label": "name", "turn": 0, "region": {"x": int, "y": int, "width": int, "height": int}}]'
      },
      question: { type: 'string', description: '本次切片探查的核心问题或验证目标' },
      session_id: { type: 'string', description: '目标会话 ID' }
    },
    output: {
      schema: ANY_SCHEMA,
      render: renderOutput
    },
    isConcurrencySafe: () => true,
    timeoutMs: 60000,
    async execute(args) {
      return await dispatchVistaTool(ctx, 'vista_inspect', args || {}, port)
    }
  })))

  // [3/4] vista_read_pixels
  ctx.effect(() => ctx.tools.register(wrapTool({
    name: 'vista_read_pixels',
    description: '【VISTA 像素矩阵数值采样】读取局部区域精确的离散 RGB/Hex 颜色值与 ASCII 字符网格，用于精准测量血条、能量槽填充比例或色块分布。',
    parameters: {
      views: {
        type: 'json',
        description: '像素采样规格列表，数组格式：[{"label": "name", "turn": 0, "region": {"x": int, "y": int, "width": int, "height": int}, "rows": int, "columns": int}]'
      },
      question: { type: 'string', description: '像素测量的目标（例如："测量黄色能量条的填充宽度"）' },
      session_id: { type: 'string', description: '目标会话 ID' }
    },
    output: {
      schema: ANY_SCHEMA,
      render: renderOutput
    },
    isConcurrencySafe: () => true,
    timeoutMs: 60000,
    async execute(args) {
      return await dispatchVistaTool(ctx, 'vista_read_pixels', args || {}, port)
    }
  })))

  // [4/4] vista_history
  ctx.effect(() => ctx.tools.register(wrapTool({
    name: 'vista_history',
    description: '【VISTA 审计追踪】读取客观的按时间排序的动作序列与观察日志，不改变环境状态。',
    parameters: {
      view: { type: 'string', description: '视图类型（events 或 attempts）' },
      start_turn: { type: 'integer', description: '起始轮次' },
      end_turn: { type: 'integer', description: '结束轮次' },
      limit: { type: 'integer', description: '最大返回条目数（默认 64）' },
      session_id: { type: 'string', description: '会话 ID' }
    },
    output: {
      schema: ANY_SCHEMA,
      render: renderOutput
    },
    isConcurrencySafe: () => true,
    timeoutMs: 30000,
    async execute(args) {
      return await dispatchVistaTool(ctx, 'vista_history', args || {}, port)
    }
  })))

  console.log(`[dsh-vista] VISTA 视觉探针插件 (v${PLUGIN_VERSION}) 已成功加载，注册了 4 个标准视觉原语。`)
}
