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

const ASSET_HASH = 'f694b6e8fb219d7ac92e0bbf2fc897669bc45ab2754124a8ccf534c627a6f682'
// asset:// 协议：cleaner 只保留 asset:// 开头的引用，/assets/ 路径会在 CLEAN=true 时被当孤儿删除
const MODEL_URL = `asset://${ASSET_HASH}.glb`
const wsUrl = process.argv[2] || 'ws://localhost:3000/ws'

// 固定 ID：重复运行时服务端按 id 幂等处理，避免堆积重复实体
const BP_ID = 'bp-whalegirl-0001'
const ENT_ID = 'ent-whalegirl-0001'

const blueprint = {
  id: BP_ID,
  version: 0,
  name: '鲸鱼娘',
  image: null,
  author: 'AIO',
  url: null,
  desc: 'AIO 自有角色资产（Tripo 生成，授权自有；41 骨骼 + 20 动画）',
  model: MODEL_URL,
  // 脚本必须为 asset:// URL（loader 按 URL 拉取）；源码文件已上传为 world/assets/<sha256>.js
  script: 'asset://4dd61c537ae91eaa069d4c3dc521b8de9c0d1091059f7e67fcb82018cceb3eec.js',
  props: {},
  preload: false,
  public: true,
  locked: false,
  frozen: false,
  unique: false,
  scene: false,
  disabled: false,
}

const entity = {
  id: ENT_ID,
  type: 'app',
  blueprint: BP_ID,
  position: [0, 0, 5],        // 广场中央喷泉旁
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  mover: null,
  pinned: false,
  state: {},
}

// 伪 viewport：isBrowser 因 window 垫片为 true，ClientControls.init 需要真实形状的 viewport
const viewport = {
  offsetWidth: 1280, offsetHeight: 720,
  style: {},
  addEventListener() {}, removeEventListener() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
  requestPointerLock() {},
}

const world = createNodeClientWorld()

// 无头环境的务实解法：SES 隔离区里的 window 无法从外部补齐，
// 直接替换 controls 的 init 为空操作（spawn 不需要键鼠绑定）
if (world.controls) {
  world.controls.init = async () => { flog('controls.init -> no-op') }
  flog('controls.init patched')
}

flog('world created, calling init -> ' + wsUrl)
world.init({ wsUrl, name: 'AIO-Setup', viewport })
flog('init returned')

world.on('connect', () => flog('event: connect'))
world.on('disconnect', () => { flog('event: disconnect'); console.error('[spawn] 连接断开'); process.exit(1) })
world.on('kick', () => flog('event: kick'))
world.on('error', (e) => flog('event: error: ' + (e?.message || e)))

// 60 秒没 ready 就强制退出，避免挂死
setTimeout(() => { flog('TIMEOUT 60s no ready'); console.error('[spawn] 60s 未就绪，退出'); process.exit(2) }, 60000).unref?.()

world.once('ready', async () => {
  flog('event: READY')
  console.log('[spawn] 已连接，开始发送蓝图与实体')
  try {
    // 检查资产可达性（ws:// 转 http:// 后静态服务直接 GET）
    const httpBase = wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '')
    const res = await fetch(new URL(`/assets/${ASSET_HASH}.glb`, httpBase))
    console.log('[spawn] 资产可达性:', res.status, res.headers.get('content-length'), 'bytes')
    if (res.status !== 200) throw new Error('模型资产不可达，请先放置 world/assets/' + ASSET_HASH + '.glb')

    world.network.send('blueprintAdded', blueprint)
    console.log('[spawn] blueprintAdded 已发送:', BP_ID)
    setTimeout(() => {
      // uploader 必须为 null：非 null 会被服务端视为"上传中"而永不落库（ServerNetwork save 流程）
      world.network.send('entityAdded', { ...entity, uploader: null })
      console.log('[spawn] entityAdded 已发送:', ENT_ID)
      setTimeout(() => { console.log('[spawn] 完成'); process.exit(0) }, 2000)
    }, 500)
  } catch (err) {
    console.error('[spawn] 失败:', err.message)
    process.exit(1)
  }
})
