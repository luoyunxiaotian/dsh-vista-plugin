# @dsh-external/dsh-vista-plugin

> **DSH (DeepSeek Harness) 物理级高精视觉探针插件**
> 基于何恺明团队 VISTA (Visual Harness) 原生架构，提供主动微观局部物理无损放大与精确像素值采样能力。

---

## 插件特性

1. **自动唤醒与自愈 (Auto-Wakeup & Watchdog)**：
   - 插件自动探活 `http://127.0.0.1:8765/health`。
   - 若 WSL2 未开机或 VISTA 守护进程未启动，插件会在后台静默通过 `wsl.exe` 拉起，无需人工干预。
2. **双模自适应通信 (Hybrid Dispatcher)**：
   - **快速通道**：优先直连本地 HTTP/SSE 守护进程（毫秒级高并发与低延迟）。
   - **降级通道**：若网络端口受阻或处于冷启动窗口，自动无缝降级为单次 `wsl.exe` stdio 进程调用。
3. **4 个标准视觉原语**（与 VISTA 论文严格对齐）：
   - `vista_play`：会话初始化与图像载入（支持 Windows 路径与 WSL 路径）。
   - `vista_inspect`：指定矩形区域物理级切片放大，并嵌入不可篡改的高清切片证据。
   - `vista_read_pixels`：对血条、能量槽或微观图标执行离散 RGB/Hex 采样与字符矩阵重构。
   - `vista_history`：全流程可复现的动作与切片观察轨迹。
4. **全自动识图意图引导**：
   - 通过 `ctx.systemPrompt.context` 自动向 DSH Agent 注入视觉推理原则，模型在遇到图像分析任务时将自动激活 VISTA，无需用户显式提示。
5. **Lossless-JSON 安全保证**：
   - 内置消毒过滤器，杜绝 `undefined`、`NaN`、`-0` 等特殊值导致 DSH 宿主崩溃。

---

## 安装与装配

本插件已作为本地包链接至 DSH 桌面端运行时：
- **插件目录**：`C:\Users\Administrator\.dsh\plugins\dsh-vista-plugin`
- **桌面 Profile**：已在 `C:\Users\Administrator\.dsh\profiles\desktop\package.json` 与 `cordis.patch.yml` 中自动装配。

重启 DSH 客户端后即可全局生效。
