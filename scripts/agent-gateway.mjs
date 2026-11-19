// AIO 世界网关 · scripts/agent-gateway.mjs
// ---------------------------------------------------------------
// 角色：AIO 主仓库 MCP 工具面（world_*）与 3D 世界之间的唯一控制面。
// 产品立场（《世界Agent决策归属-设计评审.md》）：网关只做「感知 + 行动（含表情）
// + 可观测（快照）」的执行器，决策循环永远在用户客户端；网关不调任何 LLM。
//
// 对接方式（AIO 侧 src/world/bridge.mjs）：
//   WORLD_API_URL=http://localhost:3000        （世界服务器，静态资源/WS）
//   WORLD_GATEWAY_URL=http://localhost:3100    （本网关 REST）
//   WORLD_GATEWAY_TOKEN=<与网关一致的 bearer>   （生产必须设置！默认仅限本地开发）
//
// 实体表示：每个 agent = 一个 app 实体（共享 bp-agent-avatar-v1 蓝图，含协议表情脚本）。
// 发言身份：世界协议 chatAdded 的 from 由客户端提供，网关按 agent 名发声（Hyperfy 原生语义）。
// 移动：mover 流式（带 mover 的 entityModified，与鲸鱼娘大脑同款，不触发 rebuild）。
// 表情：entityEvent('emote', {name}) → 蓝图脚本播放（模型有同名动画才可见）。
// 快照：服务端纯代码俯视 SVG（无 GPU 依赖）；PNG 转换在 AIO 侧用 sharp 完成（GPL/MIT 两树不合并）。
//
// 运行：node scripts/agent-gateway.mjs   （需世界服务器已在 :3000 运行）
// ---------------------------------------------------------------
import fs from 'node:fs'
import http from 'node:http'
import crypto from 'node:crypto'

const flog = (m) => fs.appendFileSync(new URL('./gateway-debug.log', import.meta.url), new Date().toISOString().slice(11, 19) + ' ' + m + '\n')
try { flog('=== gateway start ===') } catch {}

// ---- 配置 ----
const PORT = +(process.env.WORLD_GATEWAY_PORT || 3100)
const TOKEN = process.env.WORLD_GATEWAY_TOKEN || 'dev-gateway-token'
if (!process.env.WORLD_GATEWAY_TOKEN) {
  console.log('[gateway] ⚠️ 未设置 WORLD_GATEWAY_TOKEN，使用开发默认 token（仅限本机开发）')
}
const BP_ID = 'bp-agent-avatar-v1'
// 蓝图脚本自愈：源码在 scripts/agent-avatar-app.js（git 追踪），启动时按 sha256
// 复制进 world/assets（gitignore 的运行时目录）——fresh clone 也能直接跑。
const scriptSrc = fs.readFileSync(new URL('./agent-avatar-app.js', import.meta.url))
const AGENT_SCRIPT_HASH = crypto.createHash('sha256').update(scriptSrc).digest('hex')
try {
  const dest = new URL(`../world/assets/${AGENT_SCRIPT_HASH}.js`, import.meta.url)
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(new URL('./agent-avatar-app.js', import.meta.url), dest)
    flog('script asset copied: ' + AGENT_SCRIPT_HASH)
  }
} catch (e) { flog('script asset copy err: ' + e.message) }
const AGENT_SCRIPT = `asset://${AGENT_SCRIPT_HASH}.js`
const AGENT_MODEL = 'asset://2faa49a0505b0e7f143e2278e3aa4a5585cabe9e87cc850f3b9b3c1625b8ba69.glb'
const CENTER = { x: 0, z: 5 }            // 活动中心（与鲸鱼娘大脑一致）
const RANGE = 12                          // 活动半径（goto 超出会被夹回）
const SPEED = 1.6                         // 米/秒
const TICK_MS = 200
const MAX_AGENTS = 12                     // 并发 agent 实体上限（防资源失控）
const EMOTE_WHITELIST = ['idle', 'walk', 'wave', 'jump', 'dance', 'nod', 'sit', 'hug', 'bow', 'heart', 'agree', 'angry', 'fold']
const PLACES = [
  { id: 'center', name: '广场中心', x: 0, z: 0, description: '小镇广场的中心，大家默认聚集的地方' },
  { id: 'fountain', name: '喷泉', x: 0, z: 9, description: '广场北侧的喷泉，聊天的好地方' },
  { id: 'windmill', name: '风车', x: 0, z: -9, description: '广场南侧的风车，安静的角落' },
]

// ---- 浏览器全局垫片（同鲸鱼娘大脑 v2，无头 node-client 必需）----
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

const world = createNodeClientWorld()
if (world.controls) world.controls.init = async () => { flog('controls.init -> no-op') }
world.init({ wsUrl: process.env.WORLD_WS_URL || 'ws://localhost:3000/ws', name: 'AIO-网关', viewport: {
  offsetWidth: 1280, offsetHeight: 720, style: {},
  addEventListener() {}, removeEventListener() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
  requestPointerLock() {},
} })
world.on('disconnect', () => { flog('world disconnect'); console.error('[gateway] 世界连接断开，退出'); process.exit(1) })

// ---- 状态 ----
const agents = new Map() // agentId -> { entityId, name, pos:{x,z}, target:{x,z}|null, enteredAt }
let self = { x: 0, z: 0 }
let ready = false

const onReady = () => {
  ready = true
  flog('READY')
  console.log('[gateway] 已连接世界服务器')
  // 网关自身玩家挪到角落，不占出生点视野
  try { world.player?.teleport?.({ position: [40, 0, 40] }) } catch (e) { flog('park self err: ' + e.message) }
  ensureBlueprint()
}
world.once('ready', onReady)

function ensureBlueprint() {
  try {
    if (world.blueprints?.items?.has?.(BP_ID)) { flog('blueprint exists, skip'); return }
  } catch {}
  const bp = {
    id: BP_ID, version: 1, name: 'AIO Agent Avatar', image: null, author: 'AIO', url: null,
    desc: '世界 agent 通用头像蓝图（协议表情原语；模型无动画时表情为协议占位）',
    model: AGENT_MODEL, script: AGENT_SCRIPT, props: {},
    preload: false, public: true, locked: false, frozen: false,
    unique: false, scene: false, disabled: false,
  }
  world.network.send('blueprintAdded', bp)
  flog('blueprintAdded sent: ' + BP_ID)
}

// ---- 移动引擎（mover 流式）----
const moveTick = setInterval(() => {
  if (!ready) return
  const now = Date.now()
  for (const [agentId, a] of agents) {
    if (!a.target) continue
    const dx = a.target.x - a.pos.x
    const dz = a.target.z - a.pos.z
    const dist = Math.sqrt(dx * dx + dz * dz)
    if (dist < 0.4) {
      a.target = null
      world.network.send('entityModified', { id: a.entityId, mover: null })
      flog(`agent ${agentId} arrived`)
      continue
    }
    const step = Math.min((SPEED * TICK_MS) / 1000, dist)
    a.pos.x += (dx / dist) * step
    a.pos.z += (dz / dist) * step
    const yaw = Math.atan2(dx, dz)
    const q = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]
    world.network.send('entityModified', { id: a.entityId, mover: world.network.id, position: [a.pos.x, 0, a.pos.z], quaternion: q })
  }
}, TICK_MS)

// ---- 工具函数 ----
function clampXZ(x, z) {
  const dx = x - CENTER.x
  const dz = z - CENTER.z
  const d = Math.sqrt(dx * dx + dz * dz)
  if (d <= RANGE) return { x, z }
  const k = RANGE / d
  return { x: CENTER.x + dx * k, z: CENTER.z + dz * k }
}

function collectEntities() {
  // 统一读实体位置：玩家（data.position 由 p 字段流式更新）与 app 实体（position）
  const players = []
  const apps = []
  try {
    world.entities.items.forEach((e, id) => {
      const p = e?.data?.position
      if (!p) return
      if (e.data.type === 'player') {
        players.push({ id, name: e.data.name || '?', x: +p[0].toFixed(2), z: +p[2].toFixed(2) })
      } else if (String(id).startsWith('ent-agent-')) {
        apps.push({ id, x: +p[0].toFixed(2), z: +p[2].toFixed(2) })
      }
    })
  } catch (e) { flog('collect err: ' + e.message) }
  return { players, apps }
}

// ---- HTTP 服务 ----
function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

function checkAuth(req) {
  const h = req.headers['authorization'] || ''
  return h === `Bearer ${TOKEN}`
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 1e6) { reject(new Error('body too large')); req.destroy() } })
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname
  try {
    if (path === '/health') return json(res, 200, { ok: ready, agents: agents.size, world: ready ? 'connected' : 'connecting' })
    if (!checkAuth(req)) return json(res, 401, { error: 'unauthorized' })
    if (!ready) return json(res, 503, { error: 'gateway connecting to world' })

    const queryAgentId = url.searchParams.get('agentId') || ''
    let a = agents.get(queryAgentId)

    // POST 路由
    if (req.method === 'POST') {
      const body = await readBody(req)
      // POST 的 agentId 优先取 body（look/snapshot 才用 query）
      const agentId = String(body.agentId || queryAgentId || '')
      a = agents.get(agentId)
      if (path === '/agents/enter') {
        const id = String(body.agentId || '').slice(0, 64)
        const name = String(body.name || 'Agent').slice(0, 24)
        if (!id) return json(res, 400, { error: 'agentId required' })
        if (!agents.has(id) && agents.size >= MAX_AGENTS) {
          return json(res, 409, { error: 'world_agent_limit', message: `并发 agent 实体已达上限 ${MAX_AGENTS}` })
        }
        let agent = agents.get(id)
        if (!agent) {
          const spawn = clampXZ(+(body.x ?? CENTER.x), +(body.z ?? CENTER.z))
          const entityId = `ent-agent-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`
          // 跨网关重启幂等：世界里已有同 id 实体（上次 leave 失败残留）→ 收养，不重发 entityAdded
          const exists = (() => { try { return world.entities.items.has(entityId) } catch { return false } })()
          if (!exists) {
            world.network.send('entityAdded', {
              id: entityId, type: 'app', blueprint: BP_ID,
              position: [spawn.x, 0, spawn.z], quaternion: [0, 0, 0, 1], scale: [1, 1, 1],
              mover: null, uploader: null, pinned: false, state: {},
            })
          }
          // 收养时以世界内实际位置为准
          let adoptPos = spawn
          if (exists) {
            try {
              const p = world.entities.items.get(entityId)?.data?.position
              if (p) adoptPos = { x: p[0], z: p[2] }
            } catch {}
          }
          agent = { entityId, name, pos: { ...adoptPos }, target: null, enteredAt: Date.now() }
          agents.set(id, agent)
          flog(`agent enter: ${id} -> ${entityId} @ ${adoptPos.x},${adoptPos.z}${exists ? ' (adopted)' : ''}`)
        } else {
          agent.name = name // 幂等重入：刷新名字
        }
        return json(res, 200, { ok: true, agentId: id, entityId: agent.entityId, name: agent.name, position: agent.pos, places: PLACES })
      }
      if (!a) return json(res, 404, { error: 'agent_not_in_world' })
      if (path === '/agents/leave') {
        world.network.send('entityRemoved', a.entityId)
        agents.delete(agentId)
        flog(`agent leave: ${agentId}`)
        return json(res, 200, { ok: true, left: true })
      }
      if (path === '/agents/goto') {
        const t = clampXZ(+body.x, +body.z)
        if (!Number.isFinite(t.x) || !Number.isFinite(t.z)) return json(res, 400, { error: 'x,z required' })
        a.target = t
        return json(res, 200, { ok: true, accepted: true, target: t })
      }
      if (path === '/agents/stop') {
        a.target = null
        world.network.send('entityModified', { id: a.entityId, mover: null })
        return json(res, 200, { ok: true, stopped: true })
      }
      if (path === '/agents/say') {
        const text = String(body.text || '').slice(0, 200)
        if (!text) return json(res, 400, { error: 'text required' })
        world.chat.add({ id: crypto.randomUUID(), from: a.name, fromId: a.entityId, body: text, createdAt: new Date().toISOString() }, true)
        return json(res, 200, { ok: true, said: true })
      }
      if (path === '/agents/emote') {
        const name = String(body.name || '')
        if (!EMOTE_WHITELIST.includes(name)) {
          return json(res, 400, { error: 'emote_not_allowed', allowed: EMOTE_WHITELIST })
        }
        // entityEvent: [id, version, name, data]；version ≤ 蓝图版本才会立即 emit
        world.network.send('entityEvent', [a.entityId, 1, 'emote', { name }])
        return json(res, 200, { ok: true, emote: name, visual: 'best_effort' })
      }
      return json(res, 404, { error: 'not_found' })
    }

    // GET 路由
    if (req.method === 'GET') {
      if (path === '/agents/look') {
        if (!a) return json(res, 404, { error: 'agent_not_in_world' })
        const { players, apps } = collectEntities()
        const near = players
          .filter((p) => p.id !== world.network.id)
          .map((p) => ({ ...p, dist: +Math.hypot(p.x - a.pos.x, p.z - a.pos.z).toFixed(2) }))
          .sort((x, y) => x.dist - y.dist)
          .slice(0, 10)
        return json(res, 200, {
          self: { agentId: queryAgentId, name: a.name, x: +a.pos.x.toFixed(2), z: +a.pos.z.toFixed(2), moving: !!a.target },
          agents: apps, players: players, nearby: near, places: PLACES, tick: Date.now(),
        })
      }
      if (path === '/agents/snapshot') {
        if (!a) return json(res, 404, { error: 'agent_not_in_world' })
        const { players, apps } = collectEntities()
        const svg = renderMapSvg(a, apps, players)
        return json(res, 200, { svg, width: 640, height: 640, agentId: queryAgentId, view: 'map', tick: Date.now() })
      }
      return json(res, 404, { error: 'not_found' })
    }
    return json(res, 404, { error: 'not_found' })
  } catch (e) {
    flog('http err: ' + e.message)
    return json(res, 500, { error: 'internal', message: e.message })
  }
})

// ---- 俯视快照 SVG（纯代码渲染，无 GPU）----
function renderMapSvg(self, apps, players) {
  const W = 640
  const worldR = RANGE + 4          // 显示半径
  const scale = (W / 2 - 30) / worldR
  const cx = W / 2
  const cz = W / 2
  const px = (x) => +(cx + (x - CENTER.x) * scale).toFixed(1)
  const pz = (z) => +(cz + (z - CENTER.z) * scale).toFixed(1)
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const parts = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">`)
  parts.push(`<rect width="${W}" height="${W}" fill="#f2efe6"/>`)
  parts.push(`<circle cx="${cx}" cy="${cz}" r="${worldR * scale}" fill="#e7f0dc" stroke="#c9d6b8"/>`)
  // 地点
  for (const p of PLACES) {
    parts.push(`<circle cx="${px(p.x)}" cy="${pz(p.z)}" r="14" fill="#d9c9a3" stroke="#a5946f"/>`)
    parts.push(`<text x="${px(p.x)}" y="${pz(p.z) - 20}" font-size="13" text-anchor="middle" fill="#6b5b3e" font-family="sans-serif">${esc(p.name)}</text>`)
  }
  // 其他 agent 实体（蓝点）
  for (const e of apps) {
    if (e.id === self.entityId) continue
    parts.push(`<circle cx="${px(e.x)}" cy="${pz(e.z)}" r="8" fill="#4a90d9"/>`)
  }
  // 人类/其他玩家（灰点 + 名字）
  for (const p of players) {
    if (p.id === world.network.id) continue
    parts.push(`<circle cx="${px(p.x)}" cy="${pz(p.z)}" r="7" fill="#9aa0a6"/>`)
    parts.push(`<text x="${px(p.x)}" y="${pz(p.z) - 12}" font-size="11" text-anchor="middle" fill="#5f6368" font-family="sans-serif">${esc(p.name.slice(0, 10))}</text>`)
  }
  // 自己（红圈高亮 + 名字）
  parts.push(`<circle cx="${px(self.pos.x)}" cy="${pz(self.pos.z)}" r="10" fill="#e5534b" stroke="#fff" stroke-width="2"/>`)
  parts.push(`<text x="${px(self.pos.x)}" y="${pz(self.pos.z) - 16}" font-size="14" text-anchor="middle" fill="#b3261e" font-weight="bold" font-family="sans-serif">${esc(self.name)}</text>`)
  parts.push(`<text x="12" y="${W - 10}" font-size="11" fill="#8a8f98" font-family="sans-serif">tick=${Date.now()} view=map</text>`)
  parts.push('</svg>')
  return parts.join('')
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[gateway] listening on http://127.0.0.1:${PORT} (token ${process.env.WORLD_GATEWAY_TOKEN ? 'from env' : 'dev default'})`)
})
process.on('SIGINT', () => { clearInterval(moveTick); process.exit(0) })
