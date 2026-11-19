// 无头 spawn：把鲸鱼娘模型作为蓝图应用放进世界
// 用法：node scripts/spawn-whalegirl.mjs [wsUrl]
// 前置：world/assets/ 里已放置 <sha256>.glb；ADMIN_CODE 为空（全员 builder）
// 前置垫片：node-client 构建产物在模块顶层引用了 window/navigator（上游 agent.mjs 同坑）
// 用动态 import 保证垫片先于 bundle 执行
import fs from 'node:fs'
const flog = (m) => fs.appendFileSync(new URL('./spawn-debug.log', import.meta.url), m + '\n')
try { flog('script start') } catch {}

// 独立保存 stub 引用：SES lockdown 可能替换 globalThis.window，import 后需重新赋值
const WINDOW_STUB = {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {}, removeEventListener() {},
  devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 720,
  location: new URL('http://localhost'),
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
}
WINDOW_STUB.document = WINDOW_STUB.document || {
  createElement: () => {
    // 万能 2D/WebGL 上下文桩：兼容模块顶层执行 canvas 操作的库（如 lottie_canvas）
    const ctx = new Proxy({}, {
      get: (_t, k) => {
        if (k === 'canvas') return {}
        if (k === 'measureText') return () => ({ width: 0 })
        if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })
        return () => {}
      },
      set: () => true,
    })
  // 伪 canvas 元素：ClientControls.init 会读 offsetWidth/Height 并挂事件
  const canvasStub = {
    offsetWidth: 1280, offsetHeight: 720,
    style: {}, width: 1280, height: 720,
    addEventListener() {}, removeEventListener() {},
    focus() {}, setAttribute() {}, requestPointerLock() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
  }
  return {
    style: {}, setAttribute() {}, appendChild() {}, getContext: () => ctx, width: 0, height: 0,
  }
  },
  createTextNode: () => ({}),
  body: { appendChild() {} },
  addEventListener() {},
  getElementsByTagName: () => [],
  getElementById: () => canvasStub,
}
if (!('maxTouchPoints' in globalThis.navigator)) {
  Object.defineProperty(globalThis.navigator, 'maxTouchPoints', { value: 0, configurable: true })
}
globalThis.window = WINDOW_STUB
globalThis.document = WINDOW_STUB.document
// localStorage 桩（ClientNetwork.init 需要；Map 实现即可）
if (!globalThis.localStorage) {
  const store = new Map()
  const ls = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
  Object.defineProperty(globalThis, 'sessionStorage', { value: ls, configurable: true })
}
flog('shim done, importing bundle...')
const { createNodeClientWorld } = await import('../build/world-node-client.js')
flog('bundle imported')
// SES lockdown 后重挂 stub
if (globalThis.window !== WINDOW_STUB) { globalThis.window = WINDOW_STUB; globalThis.document = WINDOW_STUB.document; flog('window stub re-applied after SES') }

// 定位工具：把已存在的鲸鱼娘实体挪到玩家出生点附近，便于目视验收模型本体
const wsUrl = process.argv[2] || 'ws://localhost:3000/ws'
const ENT_ID = 'ent-whalegirl-0001'

const viewport = {
  offsetWidth: 1280, offsetHeight: 720, style: {},
  addEventListener() {}, removeEventListener() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
  requestPointerLock() {},
}
const world = createNodeClientWorld()
if (world.controls) world.controls.init = async () => {}
flog('place: init -> ' + wsUrl)
world.init({ wsUrl, name: 'AIO-Place', viewport })

setTimeout(() => { flog('place TIMEOUT'); process.exit(2) }, 60000).unref?.()
world.once('ready', () => {
  flog('place READY, sending entityModified')
  // mover=null：立即落库且不走插值；位置放到广场中心玩家正前方
  world.network.send('entityModified', {
    id: ENT_ID,
    position: [0, 0, 4],
    quaternion: [0, 0, 0, 1],
    scale: [2, 2, 2],
    mover: null,
  })
  console.log('[place] 鲸鱼娘已定位到 [0,0,4]（玩家正前方）')
  setTimeout(() => process.exit(0), 800)
})
