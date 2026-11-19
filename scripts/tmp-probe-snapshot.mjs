// 临时探针 v3：解码 snapshot，检查鲸鱼娘蓝图与实体
import WebSocket from 'ws'
import { unpack } from 'msgpackr'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/core/packets.js', import.meta.url), 'utf8')
const names = src.match(/const names = \[([^\]]+)\]/)[1].match(/'([^']+)'/g).map(s => s.slice(1, -1))
const SNAPSHOT = names.indexOf('snapshot')

const ws = new WebSocket(process.argv[2] || 'ws://localhost:3000/ws')
ws.on('message', (buf) => {
  try {
    const [id, data] = unpack(buf)
    if (id !== SNAPSHOT) return
    const bp = (data.blueprints || []).find(b => b.id === 'bp-whalegirl-0001')
    const ent = (data.entities || []).find(e => e.id === 'ent-whalegirl-0001')
    console.log('--- blueprint bp-whalegirl-0001 ---')
    console.log(JSON.stringify(bp, null, 1)?.slice(0, 1200))
    console.log('--- entity ent-whalegirl-0001 ---')
    console.log(JSON.stringify(ent, null, 1)?.slice(0, 600))
    console.log('--- all entities ---')
    console.log((data.entities || []).map(e => `${e.id} (${e.type})`).join(', '))
    process.exit(0)
  } catch (e) { /* ignore non-snapshot */ }
})
ws.on('error', (e) => { console.error('err', e.message); process.exit(1) })
setTimeout(() => { console.log('timeout, no snapshot'); process.exit(1) }, 10000)
