// 10X RPC — Lightweight 24/7 Gateway Daemon Server
require('dotenv').config()
const { spawn, execSync } = require('child_process')
const http = require('http')

const PORT = process.env.SERVER_PORT || process.env.PORT || 3000

console.log('====================================================')
console.log('   🚀 10X RPC Lightweight 24/7 Backend Server        ')
console.log('   Platform: Orihost / Pterodactyl Container        ')
console.log('====================================================')

// 1. HTTP health check server for Pterodactyl / Orihost monitoring
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    })
    res.end(JSON.stringify({
      status: 'ok',
      service: '10x-rpc-gateway-daemon',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    }))
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not_found' }))
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[10X RPC Server] HTTP Health check listening on 0.0.0.0:${PORT}`)
})

// 2. Ensure Prisma Client is generated
console.log('[10X RPC Server] Initializing Prisma ORM...')
try {
  execSync('npx prisma generate', { stdio: 'inherit' })
  console.log('[10X RPC Server] Prisma Client ready.')
} catch (err) {
  console.warn('[10X RPC Server] Prisma generate warning:', err.message)
}

// 3. Spawn the standalone 24/7 RPC daemon
console.log('[10X RPC Server] Launching 24/7 Discord RPC & Status Daemon...')

function startDaemon() {
  const daemon = spawn('npx', ['tsx', 'scripts/rpc-daemon-standalone.ts'], {
    stdio: 'inherit',
    env: process.env
  })

  daemon.on('close', (code) => {
    console.error(`[10X RPC Server] Daemon exited with code ${code}. Restarting in 5s...`)
    setTimeout(startDaemon, 5000)
  })

  daemon.on('error', (err) => {
    console.error('[10X RPC Server] Daemon failed to start:', err.message)
  })

  return daemon
}

const activeDaemon = startDaemon()

// 4. Keep-alive pinger — pings the Vercel frontend's /api/keep-awake every 4 minutes.
//    This keeps BOTH services warm:
//      - Vercel /api/keep-awake runs a Neon DB query (Neon suspends after ~5 min inactivity)
//      - Vercel /api/keep-awake also pings Render's /health (Render sleeps after ~15 min inactivity)
//    Creates a mutual keep-alive loop: Render -> Vercel -> Render.
const KEEPALIVE_URL = process.env.NEXT_PUBLIC_APP_URL
  ? process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '') + '/api/keep-awake'
  : null
const KEEPALIVE_INTERVAL_MS = 4 * 60 * 1000 // 4 minutes

if (KEEPALIVE_URL) {
  console.log(`[10X RPC KeepAlive] Pinging ${KEEPALIVE_URL} every 4 min (keeps Neon + Render warm)`)

  function pingKeepAlive() {
    const req = http.get(KEEPALIVE_URL, { timeout: 15000 }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try {
          const data = JSON.parse(body)
          const dbMs = data?.results?.database?.ms
          const renderMs = data?.results?.render?.ms
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

  // Initial ping after 10s (let the daemon start first)
  setTimeout(pingKeepAlive, 10000)
  // Then every 4 minutes
  setInterval(pingKeepAlive, KEEPALIVE_INTERVAL_MS)
} else {
  console.log('[10X RPC KeepAlive] NEXT_PUBLIC_APP_URL not set - skipping keep-alive pinger')
}

process.on('SIGINT', () => {
  console.log('[10X RPC Server] Received SIGINT. Shutting down...')
  server.close()
  if (activeDaemon) activeDaemon.kill('SIGINT')
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('[10X RPC Server] Received SIGTERM. Shutting down...')
  server.close()
  if (activeDaemon) activeDaemon.kill('SIGTERM')
  process.exit(0)
})
