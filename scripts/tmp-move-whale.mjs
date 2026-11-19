// 临时脚本：把鲸鱼娘挪到指定坐标（相机前方）
import WebSocket from 'ws'
import { Packr } from 'msgpackr'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/core/packets.js', import.meta.url), 'utf8')
const names = src.match(/const names = \[([^\]]+)\]/)[1].match(/'([^']+)'/g).map(s => s.slice(1, -1))
const ENTITY_MODIFIED = names.indexOf('entityModified')

const packr = new Packr({ structuredClone: true })
const url = process.argv[2] || 'ws://localhost:3000/ws'
const pos = (process.argv[3] || '0,0,-5').split(',').map(Number)

const ws = new WebSocket(url)
ws.on('open', () => {
  const packet = packr.pack([ENTITY_MODIFIED, {
    id: 'ent-whalegirl-0001',
    position: pos,
  }])
  ws.send(packet)
  console.log(`[move] sent position ${JSON.stringify(pos)}`)
  setTimeout(() => process.exit(0), 1500)
})
ws.on('error', (e) => { console.error('err', e.message); process.exit(1) })
