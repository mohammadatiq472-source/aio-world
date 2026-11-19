// 鲸鱼娘提线木偶（agent 大脑 v1：规则驱动，LLM 接口预留）
// 职责：
//   1. 更新鲸鱼娘蓝图 → 挂载动画映射表脚本（治愈 T-pose）
//   2. 放大实体 2 倍
//   3. 闲逛：200ms 周期发 entityModified（官方 builder 移动路径），随机航点 + 朝向
//   4. 社交：邻近真人玩家时用聊天打招呼（限频）
// 用法：node scripts/whalegirl-puppeteer.mjs [wsUrl] [duration秒]
import fs from 'node:fs'
const flog = (m) => fs.appendFileSync(new URL('./puppeteer-debug.log', import.meta.url), new Date().toISOString().slice(11, 19) + ' ' + m + '\n')
try { flog('=== puppeteer start ===') } catch {}

// ---- 浏览器全局垫片（node-client 构建产物需要，同 spawn-whalegirl）----
const WINDOW_STUB = {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {}, removeEventListener() {},
  devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 720,
  location: new URL('http://localhost'),
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
}
WINDOW_STUB.document = {
  createElement: () => {
    const ctx = new Proxy({}, {
      get: (_t, k) => {
        if (k === 'canvas') return {}
        if (k === 'measureText') return () => ({ width: 0 })
        if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })
        return () => {}
      },
      set: () => true,
    })
    return { style: {}, setAttribute() {}, appendChild() {}, getContext: () => ctx, width: 0, height: 0 }
  },
  createTextNode: () => ({}),
  body: { appendChild() {} },
  addEventListener() {},
  getElementsByTagName: () => [],
  getElementById: () => ({
    offsetWidth: 1280, offsetHeight: 720, style: {}, width: 1280, height: 720,
    addEventListener() {}, removeEventListener() {}, focus() {}, setAttribute() {}, requestPointerLock() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
  }),
}
if (!('maxTouchPoints' in globalThis.navigator)) {
  Object.defineProperty(globalThis.navigator, 'maxTouchPoints', { value: 0, configurable: true })
}
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
globalThis.window = WINDOW_STUB
globalThis.document = WINDOW_STUB.document
flog('shim done')

const { createNodeClientWorld } = await import('../build/world-node-client.js')
flog('bundle imported')

// ---- 配置 ----
const BP_ID = 'bp-whalegirl-0001'
const ENT_ID = 'ent-whalegirl-0001'
const ASSET_HASH = 'f694b6e8fb219d7ac92e0bbf2fc897669bc45ab2754124a8ccf534c627a6f682'
const wsUrl = process.argv[2] || 'ws://localhost:3000/ws'
const DURATION = (process.argv[3] ? +process.argv[3] : 300) * 1000
const CENTER = { x: 0, z: 5 }        // 闲逛中心（喷泉旁）
const WANDER_R = 8                   // 航点半径
const SPEED = 1.2                    // 移动速度（单位/秒）
const TICK_MS = 200                  // entityModified 周期
const GREET_DIST = 7                 // 打卡距离
const GREET_COOLDOWN = 25_000        // 打招呼限频
const CHATS = [
  '咦，你来啦～我正想去喷泉那边看看',
  '今天风车转得特别好，你看到了吗？',
  '广场的日落超好看的，记得来看！',
  '要不要一起散散步呀？',
  '我在熟悉这片小镇，到处转转～',
  '听说这附近经常有 AI 居民出没，我还没遇到过呢',
]
// 模型前向校准（+Z 假设，若世界内看到行走方向与朝向相反，调整这个值）
const MODEL_YAW_OFFSET = 0

// ---- 连接 ----
const world = createNodeClientWorld()
if (world.controls) world.controls.init = async () => { flog('controls.init -> no-op') }

world.init({ wsUrl, name: '小鲸', viewport: {
  offsetWidth: 1280, offsetHeight: 720, style: {},
  addEventListener() {}, removeEventListener() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
  requestPointerLock() {},
} })

world.on('disconnect', () => { flog('disconnect'); process.exit(1) })
setTimeout(() => { flog('duration end, exit'); process.exit(0) }, DURATION).unref?.()

world.once('ready', async () => {
  flog('READY')
  console.log('[puppeteer] 已连接')

  // 1. 蓝图 v1：挂动画映射表脚本
  const script = fs.readFileSync(new URL('./app-whalegirl-brain.js', import.meta.url), 'utf8')
  world.network.send('blueprintModified', {
    id: BP_ID, version: 1, name: '鲸鱼娘', image: null, author: 'AIO', url: null,
    desc: 'AIO 自有角色资产（Tripo 生成，授权自有；41 骨骼 + 20 动画）',
    model: `/assets/${ASSET_HASH}.glb`, script, props: {},
    preload: false, public: true, locked: false, frozen: false,
    unique: false, scene: false, disabled: false,
  })
  flog('blueprintModified v1 sent')

  // 2. 放大 2 倍 + 初始位置校准
  world.network.send('entityModified', { id: ENT_ID, scale: [2, 2, 2] })
  flog('scale 2x sent')

  // 3. 闲逛状态机
  const pos = { x: CENTER.x, z: CENTER.z }
  let target = null
  let lastGreet = 0

  const tick = setInterval(() => {
    // 选航点
    if (!target) {
      const a = Math.random() * Math.PI * 2
      const r = 3 + Math.random() * WANDER_R
      target = { x: CENTER.x + Math.cos(a) * r, z: CENTER.z + Math.sin(a) * r }
      flog(`new target (${target.x.toFixed(1)}, ${target.z.toFixed(1)})`)
    }
    // 朝航点移动
    const dx = target.x - pos.x
    const dz = target.z - pos.z
    const dist = Math.sqrt(dx * dx + dz * dz)
    if (dist < 0.4) {
      target = null
      return
    }
    const step = Math.min(SPEED * TICK_MS / 1000, dist)
    pos.x += (dx / dist) * step
    pos.z += (dz / dist) * step
    const yaw = Math.atan2(dx, dz) + MODEL_YAW_OFFSET
    const q = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]
    // 官方移动路径：entityModified（builder 同款）
    world.network.send('entityModified', { id: ENT_ID, position: [pos.x, 0, pos.z], quaternion: q })

    // 4. 社交：邻近真人打招呼
    const now = Date.now()
    if (now - lastGreet > GREET_COOLDOWN) {
      let nearest = null
      let nd = Infinity
      try {
        for (const [id, pl] of world.entities.players) {
          if (id === world.network.id) continue
          const pp = pl.root?.position || pl.data?.position
          const px = pp?.x ?? pp?.[0]
          const pz = pp?.z ?? pp?.[2]
          if (px == null || pz == null) continue
          const d = Math.sqrt((px - pos.x) ** 2 + (pz - pos.z) ** 2)
          if (d < GREET_DIST && d < nd) { nd = d; nearest = pl }
        }
      } catch (e) { flog('proximity check err: ' + e.message) }
      if (nearest) {
        const line = CHATS[Math.floor(Math.random() * CHATS.length)]
        try { world.chat.send(line); flog('chat: ' + line); lastGreet = now } catch (e) { flog('chat err: ' + e.message) }
      }
    }
  }, TICK_MS)

  // 周期性换目标（防止一直走向同一点）
  const retarget = setInterval(() => { if (!target) return }, 1000)
  setTimeout(() => { clearInterval(tick); clearInterval(retarget); flog('loop stopped') }, DURATION - 2000)
})
