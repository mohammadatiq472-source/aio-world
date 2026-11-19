// 验证：世界网关全链路（verify-agent-gateway.mjs）
// 前置：世界服务器 :3000 运行中。本脚本自起网关（随机端口），跑通
//   enter → look → goto → say → emote → snapshot → leave 全链路并断言。
// 跑法：node scripts/verify/verify-agent-gateway.mjs
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 3189
const TOKEN = 'verify-token'
const BASE = `http://127.0.0.1:${PORT}`
let pass = 0
let fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log('  ✓', label) } else { fail++; console.log('  ✗', label) } }

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

// 起网关
const gw = spawn(process.execPath, ['scripts/agent-gateway.mjs'], {
  env: { ...process.env, WORLD_GATEWAY_PORT: String(PORT), WORLD_GATEWAY_TOKEN: TOKEN, WORLD_WS_URL: 'ws://localhost:3000/ws' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
gw.stdout.on('data', () => {})
gw.stderr.on('data', (d) => console.error('  [gw-err]', String(d).slice(0, 200)))

try {
  // 等网关连上世界
  let healthy = false
  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    try {
      const r = await fetch(BASE + '/health')
      const j = await r.json()
      if (j.ok && j.world === 'connected') { healthy = true; break }
    } catch {}
  }
  ok(healthy, '网关就绪并连上世界服务器')

  // 鉴权
  const unauth = await fetch(BASE + '/agents/look?agentId=x')
  ok(unauth.status === 401, '无 token 返回 401')

  // enter
  const enter = await api('POST', '/agents/enter', { agentId: 'verify-agent-1', name: '验证员' })
  ok(enter.status === 200 && enter.data.ok, 'enter 成功')
  ok(/^ent-agent-/.test(enter.data.entityId || ''), '实体 id 前缀正确')
  const enterAgain = await api('POST', '/agents/enter', { agentId: 'verify-agent-1', name: '验证员' })
  ok(enterAgain.status === 200 && enterAgain.data.entityId === enter.data.entityId, '重复 enter 幂等')

  // 未进入的 agent 被 404
  const ghost = await api('POST', '/agents/say', { agentId: 'nope', text: 'hi' })
  ok(ghost.status === 404 && ghost.data.error === 'agent_not_in_world', '未进入 agent 返回 agent_not_in_world')

  // look
  await sleep(2000)
  const look = await api('GET', '/agents/look?agentId=verify-agent-1')
  ok(look.status === 200 && look.data.self?.agentId === 'verify-agent-1', 'look 返回 self')
  ok(Array.isArray(look.data.places) && look.data.places.length >= 3, 'look 返回地点 POI')

  // goto（去喷泉附近）+ 等到达
  const goto = await api('POST', '/agents/goto', { agentId: 'verify-agent-1', x: 0, z: 9 })
  ok(goto.status === 200 && goto.data.accepted, 'goto 被接受')
  let arrived = false
  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    const l = await api('GET', '/agents/look?agentId=verify-agent-1')
    if (l.status === 200 && !l.data.self.moving && Math.abs(l.data.self.z - 9) < 0.6 && Math.abs(l.data.self.x) < 0.6) { arrived = true; break }
  }
  ok(arrived, 'goto 到达喷泉（0,9）')

  // goto 越界被夹回
  const far = await api('POST', '/agents/goto', { agentId: 'verify-agent-1', x: 100, z: 100 })
  ok(far.status === 200 && Math.hypot(far.data.target.x, far.data.target.z - 5) <= 12 + 0.01, 'goto 越界坐标被夹回活动半径')
  await api('POST', '/agents/stop', { agentId: 'verify-agent-1' })

  // say（真发进世界 chat）
  const say = await api('POST', '/agents/say', { agentId: 'verify-agent-1', text: '验证快门，大家好！' })
  ok(say.status === 200 && say.data.said, 'say 成功（身份 from=验证员）')

  // emote 白名单
  const emoteBad = await api('POST', '/agents/emote', { agentId: 'verify-agent-1', name: 'fly_to_moon' })
  ok(emoteBad.status === 400 && emoteBad.data.error === 'emote_not_allowed', '白名单外 emote 被拒')
  const emoteOk = await api('POST', '/agents/emote', { agentId: 'verify-agent-1', name: 'wave' })
  ok(emoteOk.status === 200 && emoteOk.data.emote === 'wave', '白名单内 emote 被接受')

  // snapshot（SVG）
  const snap = await api('GET', '/agents/snapshot?agentId=verify-agent-1')
  ok(snap.status === 200 && typeof snap.data.svg === 'string' && snap.data.svg.includes('<svg'), 'snapshot 返回 SVG')
  ok(snap.data.svg.includes('验证员'), 'SVG 含 agent 名字标签')

  // leave
  const leave = await api('POST', '/agents/leave', { agentId: 'verify-agent-1' })
  ok(leave.status === 200 && leave.data.left, 'leave 成功')
  const afterLeave = await api('GET', '/agents/look?agentId=verify-agent-1')
  ok(afterLeave.status === 404, 'leave 后 look 返回 agent_not_in_world')

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
} finally {
  gw.kill()
}

process.exit(fail ? 1 : 0)
