// 10X RPC — Lightweight 24/7 Gateway Daemon Server
require('dotenv').config()
const { execSync } = require('child_process')
const http = require('http')
const https = require('https')

// Register tsx require hook so we can import .ts files (src/lib/rpc-daemon.ts etc.)
require('tsx/cjs')

const PORT = process.env.SERVER_PORT || process.env.PORT || 3000

console.log('====================================================')
console.log('   10X RPC Lightweight 24/7 Backend Server        ')
console.log('   Platform: Orihost / Pterodactyl Container        ')
console.log('====================================================')

// In-process daemon — same process as the HTTP server, so /sync-user can call it directly
let daemonInstance = null
async function getDaemon() {
  if (!daemonInstance) {
    const { getRpcDaemon } = require('./src/lib/rpc-daemon')
    daemonInstance = getRpcDaemon()
    await daemonInstance.start()
    console.log('[10X RPC Server] 24/7 daemon started in-process')
  }
  return daemonInstance
}

// 1. HTTP server: /health, /sync-user, /stop-rpc
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  if (path === '/health' || path === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'ok',
      service: '10x-rpc-gateway-daemon',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    }))
    return
  }

  // POST /sync-user?userId=xxx — instant presence sync (called by Vercel after toggle/update)
  if (path === '/sync-user' && req.method === 'POST') {
    try {
      const userId = url.searchParams.get('userId')
      if (!userId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'missing userId param' }))
        return
      }
      const d = await getDaemon()
      const result = await d.syncUser(userId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: result.ok, method: result.method, message: result.message }))
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: e.message }))
    }
    return
  }

  // POST /stop-rpc?userId=xxx — stop RPC + clear Discord presence (called by Vercel on RPC disable)
  if (path === '/stop-rpc' && req.method === 'POST') {
    try {
      const userId = url.searchParams.get('userId')
      if (!userId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'missing userId param' }))
        return
      }
      const d = await getDaemon()
      await d.stopUserRpc(userId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, message: 'RPC stopped & cleared from Discord' }))
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: e.message }))
    }
    return
  }


  // GET /debug — test fetch + asset listing (diagnostic)
  if (path === '/debug') {
    try {
      const appId = process.env.DISCORD_CLIENT_ID
      const botToken = process.env.DISCORD_BOT_TOKEN
      const hasFetch = typeof fetch !== 'undefined'
      let assetsCount = -1
      let fetchError = null
      if (hasFetch && botToken) {
        try {
          const r = await fetch('https://discord.com/api/v9/applications/' + appId + '/assets', {
            headers: { Authorization: 'Bot ' + botToken }
          })
          if (r.ok) {
            const d = await r.json()
            assetsCount = d.length
          } else {
            fetchError = 'HTTP ' + r.status
          }
        } catch (e) {
          fetchError = e.message
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({
        fetch_available: hasFetch,
        bot_token_set: !!botToken,
        client_id: appId,
        assets_count: assetsCount,
        fetch_error: fetchError,
        node_version: process.version,
        uptime: Math.floor(process.uptime())
      }))
      return
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e.message }))
      return
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
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

// 3. Start the 24/7 RPC daemon (in-process)
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
  console.log(`[10X RPC KeepAlive] Pinging ${KEEPALIVE_URL} every 4 min`)

  function pingKeepAlive() {
    const req = https.get(KEEPALIVE_URL, { timeout: 15000 }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try {
          const data = JSON.parse(body)
          const dbMs = data && data.results && data.results.database && data.results.database.ms
          console.log(`[10X RPC KeepAlive] OK -> db:${dbMs}ms`)
        } catch {
          console.log(`[10X RPC KeepAlive] OK -> HTTP ${res.statusCode}`)
        }
      })
    })
    req.on('error', (err) => console.warn(`[10X RPC KeepAlive] FAIL ${err.message}`))
    req.on('timeout', () => { req.destroy(); console.warn('[10X RPC KeepAlive] FAIL timeout') })
  }

  setTimeout(pingKeepAlive, 10000)
  setInterval(pingKeepAlive, KEEPALIVE_INTERVAL_MS)
} else {
  console.log('[10X RPC KeepAlive] NEXT_PUBLIC_APP_URL not set - skipping')
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
