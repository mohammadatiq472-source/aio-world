import 'ses'
import '../core/lockdown'
import { createRoot } from 'react-dom/client'

import { storage } from '../core/storage'
import { Client } from './world-client'

/**
 * AIO 入场票据：URL 带 `?ticket=` 时先换 world 自己的 authToken，再连 WS。
 * 为什么在渲染前做：ClientNetwork 初始化时从 storage 读 authToken，晚一步就会先以 Anonymous 连上，
 * 出现「一进去是匿名、刷新才是我」的抖动。票据只用一次，换完立刻从地址栏抹掉（避免被复制/留存）。
 */
async function consumeTicket() {
  const params = new URLSearchParams(window.location.search)
  const ticket = params.get('ticket')
  if (!ticket) return
  try {
    const res = await fetch('/api/aio-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket }),
    })
    if (res.ok) {
      const data = await res.json()
      if (data?.authToken) storage.set('authToken', data.authToken)
    } else {
      console.warn('[aio] 入场票据未通过校验：', res.status)
    }
  } catch (err) {
    console.warn('[aio] 入场登录失败：', err?.message || err)
  }
  params.delete('ticket')
  const qs = params.toString()
  window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash)
}

function App() {
  return <Client wsUrl={env.PUBLIC_WS_URL} />
}

const root = createRoot(document.getElementById('root'))

consumeTicket().finally(() => {
  root.render(<App />)
})
