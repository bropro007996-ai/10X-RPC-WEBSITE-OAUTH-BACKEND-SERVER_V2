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




  // GET /test-ws — tests if the daemon can reach gateway.discord.gg
  if (path === '/test-ws') {
    try {
      const WebSocket = require('ws')
      const gatewayUrl = 'wss://gateway.discord.gg/?v=10&encoding=json'
      const ws = new WebSocket(gatewayUrl)
      let result = { gatewayUrl, steps: [] }
      
      const timeout = setTimeout(() => {
        result.steps.push({ step: 'timeout', message: 'No HELLO within 10s' })
        try { ws.close() } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify(result, null, 2))
      }, 10000)
      
      ws.on('open', () => {
        result.steps.push({ step: 'open', ok: true })
      })
      
      ws.on('message', (data) => {
        try {
          const pl = JSON.parse(data.toString())
          if (pl.op === 10) {
            clearTimeout(timeout)
            result.steps.push({ step: 'HELLO', ok: true, heartbeat_interval: pl.d.heartbeat_interval })
            result.success = true
            try { ws.close() } catch {}
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
            res.end(JSON.stringify(result, null, 2))
          }
        } catch {}
      })
      
      ws.on('error', (err) => {
        clearTimeout(timeout)
        result.steps.push({ step: 'error', message: err.message })
        result.success = false
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify(result, null, 2))
      })
      
      ws.on('close', (code) => {
        result.steps.push({ step: 'close', code })
      })
      return
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ error: e.message }))
      return
    }
  }

  // GET /debug-payload?userId=xxx — returns the exact OP 3 payload the daemon would send
  if (path === '/debug-payload') {
    try {
      const userId = url.searchParams.get('userId')
      if (!userId) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'missing userId' }))
        return
      }
      const { PrismaClient } = require('@prisma/client')
      const db = new PrismaClient()
      const session = await db.session.findFirst({
        where: { userId, expiresAt: { gt: new Date() } },
        include: { user: { include: { trial: true, globalConfig: true } } }
      })
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'session not found' }))
        await db.$disconnect()
        return
      }
      const rpcConfig = await db.rpcConfig.findFirst({ where: { userId } })
      const gameRpcConfig = await db.gameRpcConfig.findUnique({ where: { userId } })
      await db.$disconnect()

      // Build the activity payload using the SAME code the daemon uses
      const { buildActivityPayload, buildGameActivityPayload, buildPresenceActivities } = require('./src/lib/rpc-manager')
      const { findSpoofGame } = require('./src/lib/spoof-games')

      const placeholderCtx = {
        timezone: session.user?.globalConfig?.timezone || 'UTC',
        city: session.user?.globalConfig?.city || undefined,
        rpcStartedAt: rpcConfig?.updatedAt ? new Date(rpcConfig.updatedAt).getTime() : Date.now(),
      }

      const isRpcActive = !!(session.rpcEnabled && rpcConfig?.enabled)
      const isGamesRpcActive = !!(session.gamesRpcEnabled && gameRpcConfig?.enabled)
      const isStatusActive = !!session.statusEnabled

      // Build Normal RPC activity (if active)
      let normalActivity = null
      if (isRpcActive && rpcConfig) {
        normalActivity = await buildActivityPayload(rpcConfig, placeholderCtx)
      }

      // Build Games RPC activity (if active)
      let gameActivity = null
      if (isGamesRpcActive && gameRpcConfig) {
        const game = findSpoofGame(gameRpcConfig.gameSlug)
        if (game) {
          gameActivity = await buildGameActivityPayload({
            gameSlug: game.slug, name: game.name, appId: game.app_id, img: game.img,
            state: gameRpcConfig.state, details: gameRpcConfig.details,
            largeImage: gameRpcConfig.largeImage, largeText: gameRpcConfig.largeText,
            smallImage: gameRpcConfig.smallImage, smallText: gameRpcConfig.smallText,
            button1Label: gameRpcConfig.button1Label, button1Url: gameRpcConfig.button1Url,
            button2Label: gameRpcConfig.button2Label, button2Url: gameRpcConfig.button2Url,
            partyCurrent: gameRpcConfig.partyCurrent, partyMax: gameRpcConfig.partyMax,
            startMinsAgo: gameRpcConfig.startMinsAgo, endTotalMins: gameRpcConfig.endTotalMins,
            updatedAt: gameRpcConfig.updatedAt,
          }, placeholderCtx)
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({
        userId,
        username: session.user?.username,
        isRpcActive,
        isGamesRpcActive,
        isStatusActive,
        rpcConfig_largeImage: rpcConfig?.largeImage,
        rpcConfig_largeImage_type: rpcConfig?.largeImage ? (rpcConfig.largeImage.startsWith('http') ? 'URL' : 'key') : null,
        normalActivity,
        gameActivity,
        normalActivity_largeImage: normalActivity?.assets?.large_image || null,
        gameActivity_largeImage: gameActivity?.assets?.large_image || null,
      }, null, 2))
      return
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ error: e.message, stack: e.stack?.split('\n').slice(0,5) }))
      return
    }
  }


  // GET /debug-daemon — shows the daemon's internal state (sockets, connections)
  if (path === '/debug-daemon') {
    try {
      const d = await getDaemon()
      const status = d.getStatus ? d.getStatus() : { error: 'getStatus not available' }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify(status, null, 2))
      return
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ error: e.message }))
      return
    }
  }

  // GET /debug — test fetch + asset listing + upload test (diagnostic)
  if (path === '/debug') {
    try {
      const appId = process.env.DISCORD_CLIENT_ID
      const botToken = process.env.DISCORD_BOT_TOKEN
      const hasFetch = typeof fetch !== 'undefined'
      let assetsCount = -1
      let fetchError = null
      let uploadTestResult = null

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

        // Test uploading a small test image
        try {
          const testUrl = url.searchParams.get('testUrl') || 'https://cdn.discordapp.com/app-icons/1549299168562905148/d222fc6f259e8eeea6ba57b893bf3882.png'
          uploadTestResult = { testUrl, steps: [] }

          // Step 1: download image
          const imgRes = await fetch(testUrl)
          uploadTestResult.steps.push({ step: 'download', ok: imgRes.ok, status: imgRes.status, contentType: imgRes.headers.get('content-type') })
          if (!imgRes.ok) throw new Error('download failed: ' + imgRes.status)
          const imgBuf = Buffer.from(await imgRes.arrayBuffer())
          uploadTestResult.steps.push({ step: 'buffer', size: imgBuf.length })

          // Step 2: get upload URL
          const uploadReqRes = await fetch('https://discord.com/api/v9/applications/' + appId + '/assets/upload', {
            method: 'POST',
            headers: { Authorization: 'Bot ' + botToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: 'debug_test.png', file_size: imgBuf.length, is_public: true })
          })
          uploadTestResult.steps.push({ step: 'getUploadUrl', ok: uploadReqRes.ok, status: uploadReqRes.status })
          if (!uploadReqRes.ok) {
            const errBody = await uploadReqRes.text()
            uploadTestResult.steps.push({ step: 'getUploadUrl_error', body: errBody.substring(0, 200) })
            throw new Error('getUploadUrl failed: ' + uploadReqRes.status)
          }
          const { upload_url, upload_filename } = await uploadReqRes.json()
          uploadTestResult.steps.push({ step: 'gotUploadUrl', hasUrl: !!upload_url, hasFilename: !!upload_filename })

          // Step 3: upload to GCS
          const putRes = await fetch(upload_url, {
            method: 'PUT',
            headers: { 'Content-Type': 'image/png' },
            body: imgBuf
          })
          uploadTestResult.steps.push({ step: 'uploadToGCS', ok: putRes.ok, status: putRes.status })

          // Step 4: create asset
          const createRes = await fetch('https://discord.com/api/v9/applications/' + appId + '/assets', {
            method: 'POST',
            headers: { Authorization: 'Bot ' + botToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: 'debug_test_' + Date.now(), upload_filename })
          })
          uploadTestResult.steps.push({ step: 'createAsset', ok: createRes.ok, status: createRes.status })
          if (createRes.ok) {
            const asset = await createRes.json()
            uploadTestResult.steps.push({ step: 'assetCreated', key: asset.key, assetId: asset.asset_id })
            uploadTestResult.success = true
            uploadTestResult.key = asset.key
          } else {
            const errBody = await createRes.text()
            uploadTestResult.steps.push({ step: 'createAsset_error', body: errBody.substring(0, 200) })
          }
        } catch (uploadErr) {
          uploadTestResult.error = uploadErr.message
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({
        fetch_available: hasFetch,
        bot_token_set: !!botToken,
        client_id: appId,
        assets_count: assetsCount,
        fetch_error: fetchError,
        upload_test: uploadTestResult,
        node_version: process.version,
        uptime: Math.floor(process.uptime())
      }, null, 2))
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
