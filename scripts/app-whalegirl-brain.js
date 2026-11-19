// 鲸鱼娘应用脚本 v3 · 动画映射表（蓝图 script 字段，SES 沙箱内运行，client+server 各跑一份）
// v3 新增：协议表情原语 —— 世界 MCP 工具面 world_emote → 网关 entityEvent('emote') → 这里播放。
//   表情动作从此走协议（world_emote 白名单），聊天关键词正则降级为兼容路径，不再进规范。
//   见《世界Agent决策归属-设计评审.md》§4.3（表现层动作必须协议化）。
const ANIM = {
  idle: 'idle',
  walk: 'walk',
  wait: 'wait',
  agree: 'agree',
  bow: 'bow',
  heart: 'heart_pose',
  hug: 'hug',
  angry: 'angry_01',
  fold: 'fold_arms',
}

// world_emote 白名单（与 AIO 侧 src/mcp/world-tools.mjs 的 EMOTE_WHITELIST 保持一致）
const EMOTE_PROTOCOL = new Set(Object.keys(ANIM))

// 聊天关键词 → 表情映射（仅近距离聊天触发）
const EMOTE_KEYWORDS = [
  [/抱抱|抱一个|hug/, 'hug'],
  [/你好|嗨|哈喽|hello|hi/i, 'bow'],
  [/比心|喜欢|爱你|爱心/, 'heart'],
  [/哈哈|笑死|太逗了/, 'agree'],
  [/点头|同意|对的对的|是的呢/, 'agree'],
  [/生气|哼|气人/, 'angry'],
]

let mesh = null
let playing = null
let last = null
let emoteUntil = 0

function findSkinned(node) {
  if (node.name === 'skinnedmesh') return node
  for (const c of node.children || []) {
    const r = findSkinned(c)
    if (r) return r
  }
  return null
}

function playMapped(name, loop = true, durMs = 0) {
  const clip = ANIM[name]
  if (!clip || !mesh || !mesh.anims || !mesh.anims.includes(clip)) return false
  mesh.play({ name: clip, loop, fade: 0.25 })
  playing = name
  if (durMs) emoteUntil = Date.now() + durMs
  return true
}

function nearChatter(body, fromId) {
  if (fromId === world.player?.id) return false
  const pl = world.entities?.players?.get?.(fromId)
  const pp = pl?.root?.position
  if (!pp || world.isServer) return true // 无位置信息时宽松触发
  const dx = pp.x - app.position.x
  const dz = pp.z - app.position.z
  return Math.sqrt(dx * dx + dz * dz) < 8
}

app.on('update', (dt) => {
  if (world.isServer) return // 动画只在客户端播放；移动由大脑走 mover 流式路径

  if (!mesh) {
    mesh = findSkinned(app)
    if (!mesh) return
    playMapped('idle') // 挂载即待机，治愈 T-pose
  }

  // 表情结束后回基础动画
  if (playing !== 'idle' && playing !== 'walk' && Date.now() > emoteUntil) {
    playing = null // 让下方速度逻辑接管
  }

  // 速度感知：移动→walk，静止→idle（表情期间不抢）
  const p = app.position
  if (!last) { last = { x: p.x, z: p.z }; return }
  const dx = p.x - last.x
  const dz = p.z - last.z
  last = { x: p.x, z: p.z }
  const speed = Math.sqrt(dx * dx + dz * dz) / Math.max(dt, 0.001)
  const base = speed > 0.15 ? 'walk' : 'idle'
  if ((base !== playing || playing === null) && Date.now() > emoteUntil) playMapped(base)
})

// 协议表情原语（world_emote）：entityEvent('emote', {name}) → 播放对应动画。
// 走协议的动作不要求发送者邻近（网关/工具面已做门控与限频）。
app.on('emote', (data) => {
  if (world.isServer || !mesh) return
  const name = data?.name
  if (!EMOTE_PROTOCOL.has(name)) return
  playMapped(name, false, 2400)
})

// 聊天监听：关键词触发表情（降级兼容路径；一次性播放后回基础动画）
world.on('chat', (msg) => {
  const body = msg?.body || ''
  if (world.isServer || !mesh) return
  for (const [re, name] of EMOTE_KEYWORDS) {
    if (re.test(body) && nearChatter(body, msg.fromId)) {
      playMapped(name, false, 2400)
      break
    }
  }
})
