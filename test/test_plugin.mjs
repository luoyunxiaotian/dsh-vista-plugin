// Unit test for @dsh-external/dsh-vista-plugin
import { apply } from '../lib/index.js'

console.log('====================================================')
console.log(' Testing @dsh-external/dsh-vista-plugin in Node.js')
console.log('====================================================')

const registeredTools = new Map()
const mockContext = {
  tools: {
    register: (tool) => {
      registeredTools.set(tool.name, tool)
      console.log(` -> Registered tool: ${tool.name}`)
    }
  },
  systemPrompt: {
    context: (ctxDef) => {
      console.log(` -> Registered systemPrompt context: ${ctxDef.name} (order: ${ctxDef.order})`)
    }
  },
  effect: (fn) => fn()
}

// 1. Apply plugin
apply(mockContext, { port: 8765, autoStart: false })

if (registeredTools.size !== 4) {
  console.error(`FAIL: Expected 4 tools, got ${registeredTools.size}`)
  process.exit(1)
}
console.log('PASS: All 4 primitives registered successfully.\n')

// 2. Test vista_play (load image)
console.log('Testing vista_play with case1_warzone2100_rts.jpg...')
const playTool = registeredTools.get('vista_play')
const playResult = await playTool.execute({
  image_path: 'H:/AI/VISTA_Tool/game_cases/case1_warzone2100_rts.jpg',
  session_id: 'plugin_unit_test'
})
console.log('playResult count:', Array.isArray(playResult) ? playResult.length : typeof playResult)
if (!playResult || (Array.isArray(playResult) && playResult.length === 0)) {
  console.error('FAIL: vista_play returned empty result:', playResult)
  process.exit(1)
}
console.log('PASS: vista_play succeeded.\n')

// 3. Test vista_inspect (active crop)
console.log('Testing vista_inspect on center region...')
const inspectTool = registeredTools.get('vista_inspect')
const inspectResult = await inspectTool.execute({
  session_id: 'plugin_unit_test',
  views: [
    {
      label: 'test_crop',
      turn: 0,
      region: { x: 260, y: 230, width: 90, height: 90 }
    }
  ]
})
console.log('inspectResult count:', Array.isArray(inspectResult) ? inspectResult.length : typeof inspectResult)
if (!inspectResult) {
  console.error('FAIL: vista_inspect returned empty result')
  process.exit(1)
}
console.log('PASS: vista_inspect succeeded.\n')

// 4. Test vista_read_pixels
console.log('Testing vista_read_pixels...')
const readPixelsTool = registeredTools.get('vista_read_pixels')
const pixelsResult = await readPixelsTool.execute({
  session_id: 'plugin_unit_test',
  views: [
    {
      label: 'test_pixels',
      turn: 0,
      region: { x: 180, y: 440, width: 20, height: 10 },
      rows: 2,
      columns: 4
    }
  ]
})
console.log('pixelsResult:', pixelsResult ? 'OK' : 'FAIL')
if (!pixelsResult) {
  console.error('FAIL: vista_read_pixels returned empty result')
  process.exit(1)
}
console.log('PASS: vista_read_pixels succeeded.\n')

console.log('====================================================')
console.log(' ALL PLUGIN UNIT TESTS PASSED!')
console.log('====================================================')
