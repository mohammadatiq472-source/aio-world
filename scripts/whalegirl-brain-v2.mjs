// 鲸鱼娘大脑 v2 · LLM 决策（找谁聊/聊什么/去哪）
// LLM 走 OpenAI 兼容接口，环境变量配置（延续 AIO 哲学：模型在客户端，平台不托管）：
//   LLM_API_KEY   必填（无 key 自动降级为规则大脑）
//   LLM_BASE_URL  默认 https://api.deepseek.com（兼容 DeepSeek/OpenAI/Ollama/vLLM）
//   LLM_MODEL     默认 deepseek-chat
// 用法：node scripts/whalegirl-brain-v2.mjs [wsUrl] [duration秒]
import fs from 'node:fs'
const flog = (m) => fs.appendFileSync(new URL('./brain-v2-debug.log', import.meta.url), new Date().toISOString().slice(11, 19) + ' ' + m + '\n')
try { flog('=== brain v2 start ===') } catch {}

// ---- 浏览器全局垫片（同 v1）----
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
const DURATION = (process.argv[3] ? +process.argv[3] : 600) * 1000
const CENTER = { x: 0, z: 5 }
const ACTION_RANGE = 12            // LLM goto 的活动半径
const SPEED = 1.2
const TICK_MS = 200
const DECIDE_MS = 10_000           // LLM 决策周期
const SAY_COOLDOWN = 6_000
const PAUSE_ON_ARRIVE = 2_500      // 到达航点停留（也是落库窗口）
// 从 aio-world/.env 读取 LLM 配置（key 只放客户端配置文件，不进代码库）
try {
  for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*["']?([^"'\r\n]*)["']?\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {}

const LLM_BASE = process.env.LLM_BASE_URL || 'https://api.deepseek.com'
const LLM_KEY = process.env.LLM_API_KEY || ''
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-chat'
const USE_LLM = !!LLM_KEY
const FALLBACK_CHATS = [
  '咦，你来啦～我正想去喷泉那边看看',
  '今天风车转得特别好，你看到了吗？',
  '要不要一起散散步呀？',
]

const SYSTEM_PROMPT = `你是「小鲸」，生活在 3D 小镇广场的 AI 鲸鱼娘（蓝色女仆装，好奇软萌，说话带点元气）。
广场中心 (0,0)，喷泉在 (0,9)，风车在 (0,-9)，你的活动范围是以广场中心为圆心半径 12 的圆形区域。
你定期收到感知快照，请决定下一个动作，只输出一个 JSON 对象：
{"action":"goto","x":数字,"z":数字}   走到某处（x,z 必须在活动范围内）
{"action":"say","text":"..."}         说话（30 字内，软萌语气；想让他做动作可在文本里自然带关键词：抱抱/你好/比心/哈哈，模型会做出对应动画）
{"action":"idle"}                     原地停留一会儿
规则：有人跟你说话或刚出现在附近时优先回应；不重复自己说过的话；没有值得说的就 goto 或 idle。`

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
setTimeout(() => { flog('duration end'); console.log('[brain] 时长结束，退出'); process.exit(0) }, DURATION).unref?.()

// ---- 感知状态 ----
const pos = { x: CENTER.x, z: CENTER.z }
const chatLog = []            // {name, body, t}
world.on('chat', (msg) => {
  if (!msg?.body) return
  chatLog.push({ name: msg.from || '?', body: msg.body, t: Date.now(), fromId: msg.fromId })
  if (chatLog.length > 12) chatLog.shift()
})

function nearbyPlayers() {
  const out = []
  try {
    for (const [id, pl] of world.entities.players) {
      if (id === world.network.id) continue
      const pp = pl.root?.position
      if (!pp) continue
      const d = Math.sqrt((pp.x - pos.x) ** 2 + (pp.z - pos.z) ** 2)
      out.push({ name: pl.data?.name || id, dist: +d.toFixed(1) })
    }
  } catch (e) { flog('perception err: ' + e.message) }
  return out.sort((a, b) => a.dist - b.dist).slice(0, 4)
}

// ---- 动作执行 ----
const self = { target: null, pauseUntil: 0, lastSay: 0, lastAction: 'none' }
function doAction(act) {
  if (!act || typeof act !== 'object') return
  if (act.action === 'goto') {
    let x = Math.max(-ACTION_RANGE, Math.min(ACTION_RANGE, +act.x || 0))
    let z = Math.max(-ACTION_RANGE, Math.min(ACTION_RANGE, +act.z || 0))
    const d = Math.sqrt(x * x + (z - 0) * 2 * 0) // noop guard
    const dist = Math.sqrt((x - CENTER.x) ** 2 + (z - CENTER.z) ** 2)
    if (dist > ACTION_RANGE) { x = CENTER.x + (x - CENTER.x) / dist * ACTION_RANGE; z = CENTER.z + (z - CENTER.z) / dist * ACTION_RANGE }
    self.target = { x, z }
    self.pauseUntil = 0
    flog(`LLM goto (${x.toFixed(1)}, ${z.toFixed(1)})`)
  } else if (act.action === 'say' && act.text) {
    if (Date.now() - self.lastSay < SAY_COOLDOWN) { flog('say 冷却中，丢弃'); return }
    try { world.chat.send(String(act.text).slice(0, 120)); flog('LLM say: ' + act.text); self.lastSay = Date.now() } catch (e) { flog('say err: ' + e.message) }
  } else if (act.action === 'idle') {
    self.target = null
    self.pauseUntil = Date.now() + 4000
    flog('LLM idle 4s')
  }
  self.lastAction = act.action
}

async function callLLM(perception) {
  const res = await fetch(LLM_BASE.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(perception) },
      ],
      temperature: 0.8,
      max_tokens: 200,
      response_format: { type: 'json_object' },
    }),
  })
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`)
  const data = await res.json()
  return JSON.parse(data.choices?.[0]?.message?.content || '{}')
}

function fallbackDecision() {
  // 规则大脑：有人靠近就打招呼，否则随机 goto
  const near = nearbyPlayers()
  if (near.length && Date.now() - self.lastSay > 20_000) {
    return { action: 'say', text: FALLBACK_CHATS[Math.floor(Math.random() * FALLBACK_CHATS.length)] }
  }
  const a = Math.random() * Math.PI * 2
  const r = 3 + Math.random() * 8
  return { action: 'goto', x: CENTER.x + Math.cos(a) * r, z: CENTER.z + Math.sin(a) * r }
}

// ---- 移动 tick（mover 流式：走 lerp 路径，不触发 rebuild）----
let moverOn = false
const moveTick = setInterval(() => {
  const now = Date.now()
  if (self.pauseUntil > now) {
    if (moverOn) { world.network.send('entityModified', { id: ENT_ID, mover: null }); moverOn = false; flog('mover off（落库窗口）') }
    return
  }
  if (!self.target) {
    const a = Math.random() * Math.PI * 2
    const r = 3 + Math.random() * 8
    self.target = { x: CENTER.x + Math.cos(a) * r, z: CENTER.z + Math.sin(a) * r }
    return
  }
  const dx = self.target.x - pos.x
  const dz = self.target.z - pos.z
  const dist = Math.sqrt(dx * dx + dz * dz)
  if (dist < 0.4) {
    self.target = null
    world.network.send('entityModified', { id: ENT_ID, mover: null })
    moverOn = false
    self.pauseUntil = now + PAUSE_ON_ARRIVE
    flog('arrived, pause 2.5s（mover off）')
    return
  }
  const step = Math.min(SPEED * TICK_MS / 1000, dist)
  pos.x += (dx / dist) * step
  pos.z += (dz / dist) * step
  const yaw = Math.atan2(dx, dz)
  const q = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]
  world.network.send('entityModified', { id: ENT_ID, mover: world.network.id, position: [pos.x, 0, pos.z], quaternion: q })
  moverOn = true
}, TICK_MS)

// ---- 决策循环 ----
let deciding = false
const decideTick = setInterval(async () => {
  if (deciding) return
  deciding = true
  try {
    const perception = {
      self: { x: +pos.x.toFixed(1), z: +pos.z.toFixed(1), state: self.target ? 'walking' : (Date.now() < self.pauseUntil ? 'resting' : 'idle') },
      nearbyPlayers: nearbyPlayers(),
      recentChat: chatLog.slice(-6).map((c) => ({ name: c.name, text: c.body.slice(0, 60) })),
      lastAction: self.lastAction,
    }
    let act
    if (USE_LLM) {
      act = await callLLM(perception)
      flog('LLM decision: ' + JSON.stringify(act).slice(0, 140))
    } else {
      if (!brainWarned) { brainWarned = true; flog('LLM_API_KEY 未配置 → 规则大脑模式（配置后自动切换 LLM）') }
      act = fallbackDecision()
    }
    doAction(act)
  } catch (e) {
    flog('decision err: ' + e.message + ' → fallback')
    doAction(fallbackDecision())
  } finally {
    deciding = false
  }
}, DECIDE_MS)
let brainWarned = false

setTimeout(() => { clearInterval(moveTick); clearInterval(decideTick); flog('loops stopped') }, DURATION - 2000)

world.once('ready', async () => {
  flog('READY')
  console.log(`[brain] 已连接（${USE_LLM ? 'LLM 模式: ' + LLM_MODEL + ' @ ' + LLM_BASE : '规则大脑模式：未配置 LLM_API_KEY'}）`)
  // 蓝图 v4：脚本改为 asset:// URL + 协议表情原语（app.on('emote')）。
  // 客户端/服务端 loader 只支持按 URL 拉脚本；之前把源码塞进 script 字段会被
  // resolveURL 拼成 https://<源码> 去 fetch，必然失败 → 红盒子。
  // v3→v4 变更：新增协议表情监听（world_emote → entityEvent('emote')），关键词正则降级兼容。
  const scriptUrl = 'asset://cd62671bfe9d76958966c3e530cd2df651fbcec5f19de5b272968567c5410a32.js'
  world.network.send('blueprintModified', {
    id: BP_ID, version: 4, name: '鲸鱼娘', image: null, author: 'AIO', url: null,
    desc: 'AIO 自有角色资产（Tripo 生成；v4 协议表情原语 + 脚本 asset 化）',
    // asset:// 协议：cleaner 只保留 asset:// 开头的引用，/assets/ 路径会在 CLEAN=true 时被当孤儿删除
    model: `asset://${ASSET_HASH}.glb`, script: scriptUrl, props: {},
    preload: false, public: true, locked: false, frozen: false,
    unique: false, scene: false, disabled: false,
  })
  flog('blueprintModified v2 sent')
  world.network.send('entityModified', { id: ENT_ID, scale: [2, 2, 2] })
  console.log('[brain] 蓝图 v2（动画映射+表情）已挂载，开始 LLM 决策循环')
})
