// 10X RPC — Lightweight 24/7 Gateway Daemon Server
require('dotenv').config()
const { spawn, execSync } = require('child_process')
const http = require('http')
const https = require('https')

const PORT = process.env.SERVER_PORT || process.env.PORT || 3000

console.log('====================================================')
console.log('   10X RPC Lightweight 24/7 Backend Server        ')
console.log('   Platform: Orihost / Pterodactyl Container        ')
console.log('====================================================')

// Lazy-load the daemon (tsx-compiled). We import it after Prisma is generated.
let daemonInstance = null
async function getDaemon() {
  if (!daemonInstance) {
    const mod = require('./src/lib/rpc-daemon')
    const { getRpcDaemon } = mod
    daemonInstance = getRpcDaemon()
    await daemonInstance.start()
  }
  return daemonInstance
}

// 1. HTTP health + sync-user server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname

  if (path === '/health' || path === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({
      status: 'ok',
      service: '10x-rpc-gateway-daemon',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    }))
    return
  }

  // POST /sync-user?userId=xxx — called by Vercel serverless functions to tell the
  // 24/7 Render daemon to immediately sync a user's presence (after toggle/update).
  // This bridges the serverless↔long-lived gap: Vercel can't hold gateway sockets,
  // so it tells Render to do the actual Discord push.
  if (path === '/sync-user' && req.method === 'POST') {
    try {
      const userId = url.searchParams.get('userId')
      if (!userId) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ ok: false, error: 'missing userId param' }))
        return
      }
      const d = await getDaemon()
      const result = await d.syncUser(userId)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ ok: result.ok, method: result.method, message: result.message }))
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ ok: false, error: e.message }))
    }
    return
  }

  // POST /stop-rpc?userId=xxx — called by Vercel to tell the daemon to STOP RPC for a user
  // (clears Discord presence). Used when /api/rpc/toggle disables RPC.
  if (path === '/stop-rpc' && req.method === 'POST') {
    try {
      const userId = url.searchParams.get('userId')
      if (!userId) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ ok: false, error: 'missing userId param' }))
        return
      }
      const d = await getDaemon()
      await d.stopUserRpc(userId)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ ok: true, message: 'RPC stopped & cleared from Discord' }))
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ ok: false, error: e.message }))
    }
    return
  }

  // OPTIONS preflight for CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify({ error: 'not_found' }))
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[10X RPC Server] HTTP listening on 0.0.0.0:${PORT} (/health, /sync-user, /stop-rpc)`)
})

// 2. Ensure Prisma Client is generated
console.log('[10X RPC Server] Initializing Prisma ORM...')
try {
  execSync('npx prisma generate', { stdio: 'inherit' })
  console.log('[10X RPC Server] Prisma Client ready.')
} catch (err) {
  console.warn('[10X RPC Server] Prisma generate warning:', err.message)
}

// 3. Start the 24/7 RPC daemon (in-process, long-lived)
console.log('[10X RPC Server] Starting 24/7 Discord RPC & Status Daemon...')
getDaemon().catch(err => {
  console.error('[10X RPC Server] Daemon failed to start:', err)
})

// 4. Keep-alive pinger — pings Vercel /api/keep-awake every 4 min (keeps Neon + Render warm)
const KEEPALIVE_URL = process.env.NEXT_PUBLIC_APP_URL
  ? process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '') + '/api/keep-awake'
  : null
const KEEPALIVE_INTERVAL_MS = 4 * 60 * 1000

if (KEEPALIVE_URL) {
  console.log(`[10X RPC KeepAlive] Pinging ${KEEPALIVE_URL} every 4 min (keeps Neon + Render warm)`)

  function pingKeepAlive() {
    const req = https.get(KEEPALIVE_URL, { timeout: 15000 }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try {
          const data = JSON.parse(body)
          const dbMs = data && data.results && data.results.database && data.results.database.ms
          const renderMs = data && data.results && data.results.render && data.results.render.ms
          console.log(`[10X RPC KeepAlive] OK ${KEEPALIVE_URL} -> db:${dbMs}ms render:${renderMs}ms`)
        } catch {
          console.log(`[10X RPC KeepAlive] OK ${KEEPALIVE_URL} -> HTTP ${res.statusCode}`)
        }
      })
    })
    req.on('error', (err) => {
      console.warn(`[10X RPC KeepAlive] FAIL ${err.message}`)
    })
    req.on('timeout', () => {
      req.destroy()
      console.warn('[10X RPC KeepAlive] FAIL timeout (15s)')
    })
  }

  setTimeout(pingKeepAlive, 10000)
  setInterval(pingKeepAlive, KEEPALIVE_INTERVAL_MS)
} else {
  console.log('[10X RPC KeepAlive] NEXT_PUBLIC_APP_URL not set - skipping keep-alive pinger')
}

process.on('SIGINT', () => {
  console.log('[10X RPC Server] Received SIGINT. Shutting down...')
  server.close()
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('[10X RPC Server] Received SIGTERM. Shutting down...')
  server.close()
  process.exit(0)
})
