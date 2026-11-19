// 临时探针 v2：msgpackr 解码，统计鲸鱼娘 entityModified 帧
import WebSocket from 'ws'
import { unpack } from 'msgpackr'
import { readFileSync } from 'node:fs'

// packets.js 里 names 数组按序分配 id
const src = readFileSync(new URL('../src/core/packets.js', import.meta.url), 'utf8')
const namesMatch = src.match(/const names = \[([^\]]+)\]/)
const names = namesMatch[1].match(/'([^']+)'/g).map(s => s.slice(1, -1))
const ids = {}
names.forEach((name, i) => { ids[i] = name })
console.log('[probe] entityModified id =', ids.indexOf ? names.indexOf('entityModified') : '?')

const url = process.argv[2] || 'ws://localhost:3000/ws'
const ws = new WebSocket(url)
let count = 0
let totalFrames = 0
let lastPos = null
let firstPos = null

ws.on('open', () => console.log('[probe] connected'))
ws.on('message', (buf) => {
  totalFrames++
  try {
    const [id, data] = unpack(buf)
    const name = ids[id]
    if (name === 'entityModified' && data?.id === 'ent-whalegirl-0001') {
      count++
      if (data.position) {
        lastPos = data.position
        if (!firstPos) firstPos = data.position
      }
    }
  } catch { /* ignore */ }
})
ws.on('error', (e) => console.error('[probe] error', e.message))
setTimeout(() => {
  console.log(`[probe] total frames: ${totalFrames}, whalegirl entityModified: ${count}`)
  console.log(`[probe] firstPos=${JSON.stringify(firstPos)} lastPos=${JSON.stringify(lastPos)}`)
  process.exit(0)
}, 10000)
