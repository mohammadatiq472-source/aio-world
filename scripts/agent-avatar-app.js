// Agent Avatar 蓝图脚本 v1 · 协议表情原语（SES 沙箱内运行，client+server 各跑一份）
// 世界 MCP 工具面 world_emote → 网关 entityEvent('emote', {name}) → 这里播放。
// 适配任意 GLB：模型有同名动画剪辑就播放；没有则静态显示（played 由网关侧按需标注）。
// 见《世界Agent决策归属-设计评审.md》§4.3：表现层动作走协议，禁止聊天关键词猜测。
const ANIM = {
  idle: 'idle',
  walk: 'walk',
  wave: 'wave',
  jump: 'jump',
  dance: 'dance',
  nod: 'nod',
  sit: 'sit',
  hug: 'hug',
  bow: 'bow',
  heart: 'heart_pose',
  agree: 'agree',
  angry: 'angry_01',
  fold: 'fold_arms',
}

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

app.on('emote', (data) => {
  if (world.isServer || !mesh) return
  const name = data?.name
  if (!name || !(name in ANIM)) return
  playMapped(name, false, 2400)
})

app.on('update', (dt) => {
  if (world.isServer) return // 动画只在客户端播放；移动由网关走 mover 流式路径

  if (!mesh) {
    mesh = findSkinned(app)
    if (!mesh) return
    playMapped('idle')
  }

  if (playing !== 'idle' && playing !== 'walk' && Date.now() > emoteUntil) {
    playing = null
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
