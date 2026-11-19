import 'ses'
import '../core/lockdown'
import './bootstrap'

import fs from 'fs-extra'
import path from 'path'
import Fastify from 'fastify'
import ws from '@fastify/websocket'
import cors from '@fastify/cors'
import compress from '@fastify/compress'
import statics from '@fastify/static'
import multipart from '@fastify/multipart'

import { createServerWorld } from '../core/createServerWorld'
import { getDB } from './db'
import { createJWT } from '../core/utils-server'
import crypto from 'node:crypto'
import { Storage } from './Storage'
import { assets } from './assets'
import { collections } from './collections'
import { cleaner } from './cleaner'

const rootDir = path.join(__dirname, '../')
const worldDir = path.join(rootDir, process.env.WORLD)
const port = process.env.PORT

// check envs
if (!process.env.WORLD) {
  throw new Error('[envs] WORLD not set')
}
if (!process.env.PORT) {
  throw new Error('[envs] PORT not set')
}
if (!process.env.JWT_SECRET) {
  throw new Error('[envs] JWT_SECRET not set')
}
if (!process.env.ADMIN_CODE) {
  console.warn('[envs] ADMIN_CODE not set - all users will have admin permissions!')
}
if (!process.env.SAVE_INTERVAL) {
  throw new Error('[envs] SAVE_INTERVAL not set')
}
if (!process.env.PUBLIC_MAX_UPLOAD_SIZE) {
  throw new Error('[envs] PUBLIC_MAX_UPLOAD_SIZE not set')
}
if (!process.env.PUBLIC_WS_URL) {
  throw new Error('[envs] PUBLIC_WS_URL not set')
}
if (!process.env.PUBLIC_WS_URL.startsWith('ws')) {
  throw new Error('[envs] PUBLIC_WS_URL must start with ws:// or wss://')
}
if (!process.env.PUBLIC_API_URL) {
  throw new Error('[envs] PUBLIC_API_URL must be set')
}
if (!process.env.ASSETS) {
  throw new Error(`[envs] ASSETS must be set to 'local' or 's3'`)
}
if (!process.env.ASSETS_BASE_URL) {
  throw new Error(`[envs] ASSETS_BASE_URL must be set`)
}
if (process.env.ASSETS === 's3' && !process.env.ASSETS_S3_URI) {
  throw new Error(`[envs] ASSETS_S3_URI must be set when using ASSETS=s3`)
}

const fastify = Fastify({ logger: { level: 'error' } })

// create world folder if needed
await fs.ensureDir(worldDir)

// init assets
await assets.init({ rootDir, worldDir })

// init collections
await collections.init({ rootDir, worldDir })

// init db
const db = await getDB({ worldDir })

// init cleaner
await cleaner.init({ db })

// init storage
const storage = new Storage(path.join(worldDir, '/storage.json'))

// create world
const world = createServerWorld()
await world.init({
  assetsDir: assets.dir,
  assetsUrl: assets.url,
  db,
  assets,
  storage,
  collections: collections.list,
})

fastify.register(cors)
fastify.register(compress)
fastify.get('/', async (req, reply) => {
  const title = world.settings.title || 'World'
  const desc = world.settings.desc || ''
  const image = world.resolveURL(world.settings.image?.url) || ''
  const url = process.env.ASSETS_BASE_URL
  const filePath = path.join(__dirname, 'public', 'index.html')
  let html = fs.readFileSync(filePath, 'utf-8')
  html = html.replaceAll('{url}', url)
  html = html.replaceAll('{title}', title)
  html = html.replaceAll('{desc}', desc)
  html = html.replaceAll('{image}', image)
  reply.type('text/html').send(html)
})
fastify.register(statics, {
  root: path.join(__dirname, 'public'),
  prefix: '/',
  decorateReply: false,
  setHeaders: res => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
  },
})
if (world.assetsDir) {
  fastify.register(statics, {
    root: world.assetsDir,
    prefix: '/assets/',
    decorateReply: false,
    setHeaders: res => {
      // all assets are hashed & immutable so we can use aggressive caching
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable') // 1 year
      res.setHeader('Expires', new Date(Date.now() + 31536000000).toUTCString()) // older browsers
    },
  })
}
fastify.register(multipart, {
  limits: {
    fileSize: 200 * 1024 * 1024, // 200MB
  },
})
fastify.register(ws)
fastify.register(worldNetwork)

const publicEnvs = {}
for (const key in process.env) {
  if (key.startsWith('PUBLIC_')) {
    const value = process.env[key]
    publicEnvs[key] = value
  }
}
const envsCode = `
  if (!globalThis.env) globalThis.env = {}
  globalThis.env = ${JSON.stringify(publicEnvs)}
`
fastify.get('/env.js', async (req, reply) => {
  reply.type('application/javascript').send(envsCode)
})

fastify.post('/api/upload', async (req, reply) => {
  const mp = await req.file()
  // collect into buffer
  const chunks = []
  for await (const chunk of mp.file) {
    chunks.push(chunk)
  }
  const buffer = Buffer.concat(chunks)
  // convert to file
  const file = new File([buffer], mp.filename, {
    type: mp.mimetype || 'application/octet-stream',
  })
  // upload
  await assets.upload(file)
})

fastify.get('/api/upload-check', async (req, reply) => {
  const exists = await assets.exists(req.query.filename)
  return { exists }
})

// ---------------------------------------------------------------- AIO 单点登录（可选）
// 人类从 AIO 网页点「进入 3D 空间」时带 `?ticket=`：AIO 用 WORLD_TICKET_SECRET 签
// `base64url(payload).hmac` 的短 TTL 票据，这里校验后换成世界自己的 JWT（authToken）。
// 为什么不让 world 直接读 AIO 会话：两个域、两套存储、两套鉴权；票据是唯一需要共享的东西，
// 且只含 pid/昵称/头像/过期时间——world 不持久化任何 AIO 凭据（JWT_SECRET 仍是世界自己的）。
// 未配置 AIO_WORLD_TICKET_SECRET 时该端点 503，世界保持「匿名入场」的默认行为。
fastify.post('/api/aio-login', async (req, reply) => {
  const secret = process.env.AIO_WORLD_TICKET_SECRET
  if (!secret) return reply.code(503).send({ error: 'sso_disabled' })
  const ticket = String(req.body?.ticket || '')
  const dot = ticket.lastIndexOf('.')
  if (dot <= 0) return reply.code(400).send({ error: 'invalid_ticket' })
  const payload = ticket.slice(0, dot)
  const sig = ticket.slice(dot + 1)
  const expect = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expect)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return reply.code(401).send({ error: 'invalid_ticket' })
  }
  let data
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return reply.code(400).send({ error: 'invalid_ticket' })
  }
  const now = Math.floor(Date.now() / 1000)
  if (!data || !Number.isInteger(data.pid) || !Number.isFinite(data.exp) || data.exp < now) {
    return reply.code(401).send({ error: 'expired' })
  }
  // 稳定身份：同一 AIO 用户永远映射到同一个 world 用户 id（name/avatar 可随资料更新）
  const id = `aio-${data.pid}`
  const name = String(data.name || 'AIO 用户').slice(0, 32)
  const avatar = typeof data.avatar === 'string' && /^https:\/\//.test(data.avatar) ? data.avatar : null
  const existing = await db('users').where('id', id).first()
  if (existing) {
    await db('users').where('id', id).update({ name, avatar })
  } else {
    await db('users').insert({ id, name, avatar, rank: 0, createdAt: new Date().toISOString() })
  }
  const authToken = await createJWT({ userId: id })
  return { authToken, user: { id, name } }
})


fastify.get('/health', async (request, reply) => {
  try {
    // Basic health check
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    }

    return reply.code(200).send(health)
  } catch (error) {
    console.error('Health check failed:', error)
    return reply.code(503).send({
      status: 'error',
      timestamp: new Date().toISOString(),
    })
  }
})

fastify.get('/status', async (request, reply) => {
  try {
    const status = {
      uptime: Math.round(world.time),
      protected: process.env.ADMIN_CODE !== undefined ? true : false,
      connectedUsers: [],
      commitHash: process.env.COMMIT_HASH,
    }
    for (const socket of world.network.sockets.values()) {
      status.connectedUsers.push({
        id: socket.player.data.userId,
        position: socket.player.position.value.toArray(),
        name: socket.player.data.name,
      })
    }

    return reply.code(200).send(status)
  } catch (error) {
    console.error('Status failed:', error)
    return reply.code(503).send({
      status: 'error',
      timestamp: new Date().toISOString(),
    })
  }
})

fastify.setErrorHandler((err, req, reply) => {
  console.error(err)
  reply.status(500).send()
})

try {
  await fastify.listen({ port, host: '0.0.0.0' })
} catch (err) {
  console.error(err)
  console.error(`failed to launch on port ${port}`)
  process.exit(1)
}

async function worldNetwork(fastify) {
  fastify.get('/ws', { websocket: true }, (ws, req) => {
    world.network.onConnection(ws, req.query)
  })
}

console.log(`server listening on port ${port}`)

// Graceful shutdown
process.on('SIGINT', async () => {
  await fastify.close()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await fastify.close()
  process.exit(0)
})
