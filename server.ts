import { createServer } from "http"
import next from "next"
import { initSocketServer, sponsoredMessageScheduler, stopAllOpsBroadcasts } from "./lib/socket-server"
import { stopChatLifecycleSweeper } from "./lib/chat-lifecycle"
import { stopPresenceSweeper } from "./lib/presence-sweeper"
import { stopSentimentSweeper } from "./lib/sentiment-sweeper"
import { ensureBucketExists } from "./lib/tigris"
import { validateEnv, googleSignInConfigWarning } from "./lib/env"

// Environment configuration
const dev = process.env.NODE_ENV !== "production"
// Always bind to 0.0.0.0 in production (Railway sets HOSTNAME to container name, not bind address)
const hostname = dev ? (process.env.HOSTNAME || "localhost") : "0.0.0.0"
const port = parseInt(process.env.PORT || "3000", 10)

console.log(`[${new Date().toISOString()}] > Server startup initiated`)
console.log(`[${new Date().toISOString()}] > NODE_ENV: ${process.env.NODE_ENV}`)
console.log(`[${new Date().toISOString()}] > PORT: ${port}`)
console.log(`[${new Date().toISOString()}] > HOSTNAME: ${hostname}`)

// Validate critical environment variables in production (presence AND shape,
// e.g. secrets must meet their minimum length - not just "is set")
if (!dev) {
  try {
    validateEnv()
    console.log(`[${new Date().toISOString()}] > All required environment variables present and valid`)
    // Not fatal — an environment without the organiser landing page is valid.
    // But an unset token means every lead POST 401s and the public demo form
    // shows an error indefinitely, which is otherwise invisible from here.
    if (!process.env.LANDING_INGEST_TOKEN) {
      console.warn(`[${new Date().toISOString()}] ⚠ LANDING_INGEST_TOKEN unset — POST /api/leads will reject every request`)
    }
    // Same shape, same reason: a half-configured Google client set breaks
    // sign-in for every mobile user while the health check stays green.
    const googleWarning = googleSignInConfigWarning({
      GOOGLE_WEB_CLIENT_ID: process.env.GOOGLE_WEB_CLIENT_ID,
      GOOGLE_IOS_CLIENT_ID: process.env.GOOGLE_IOS_CLIENT_ID,
      GOOGLE_ANDROID_CLIENT_ID: process.env.GOOGLE_ANDROID_CLIENT_ID,
    })
    if (googleWarning) {
      console.warn(`[${new Date().toISOString()}] ⚠ Google sign-in: ${googleWarning}`)
    }
  } catch {
    console.error(`[${new Date().toISOString()}] ❌ Environment validation failed, see errors above`)
    process.exit(1)
  }
}

// Create Next.js app
console.log(`[${new Date().toISOString()}] > Creating Next.js app instance...`)
const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

console.log(`[${new Date().toISOString()}] > Starting server in ${dev ? 'development' : 'production'} mode...`)
console.log(`[${new Date().toISOString()}] > Preparing Next.js app...`)

app.prepare().then(() => {
  console.log(`[${new Date().toISOString()}] > Next.js app prepared successfully`)

  // Ensure Tigris bucket exists with public-read policy
  ensureBucketExists().catch((err) => {
    console.warn(`[${new Date().toISOString()}] > Tigris bucket setup warning:`, err)
  })

  // Create HTTP server
  console.log(`[${new Date().toISOString()}] > Creating HTTP server...`)
  const httpServer = createServer((req, res) => {
    handle(req, res)
  })
  console.log(`[${new Date().toISOString()}] > HTTP server created`)

  // Initialize Socket.io
  console.log(`[${new Date().toISOString()}] > Initializing Socket.io...`)
  const io = initSocketServer(httpServer)
  console.log(`[${new Date().toISOString()}] > Socket.io initialized`)

  // Graceful shutdown
  const shutdown = () => {
    console.log(`\n[${new Date().toISOString()}] > Shutting down gracefully...`)
    // Clear the sponsored-message setInterval handles; without this they keep
    // the event loop alive and the process waits for the forced-exit timeout.
    sponsoredMessageScheduler.stopAll()
    stopChatLifecycleSweeper()
    stopPresenceSweeper()
    stopSentimentSweeper()
    // The fifth timer. `startOpsBroadcast` arms a 5s interval per event any
    // time someone opens a live ops screen, and this was the one loop the
    // shutdown handler never stopped -- so a deploy during a live event held
    // the event loop open for the full 10s forced-exit timeout and exited 1.
    stopAllOpsBroadcasts()
    io?.close(() => {
      console.log(`[${new Date().toISOString()}] > Socket.io closed`)
    })
    httpServer.close(() => {
      console.log(`[${new Date().toISOString()}] > HTTP server closed`)
      process.exit(0)
    })

    // Force exit after 10 seconds
    setTimeout(() => {
      console.error(`[${new Date().toISOString()}] > Forced shutdown after timeout`)
      process.exit(1)
    }, 10000)
  }

  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)

  // Start server
  console.log(`[${new Date().toISOString()}] > Starting HTTP server on ${hostname}:${port}...`)
  httpServer.listen(port, hostname, () => {
    console.log(`[${new Date().toISOString()}] > HTTP server listening`)
    console.log(`
╔═══════════════════════════════════════════════════╗
║           Blendn Admin Server Started             ║
╠═══════════════════════════════════════════════════╣
║  Environment: ${(dev ? "development" : "production").padEnd(34)}║
║  URL:         http://${hostname}:${port}${" ".repeat(Math.max(0, 25 - hostname.length - String(port).length))}║
║  Socket.io:   Ready                               ║
╚═══════════════════════════════════════════════════╝
    `)
  })

  httpServer.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] > HTTP server error:`, err)
    process.exit(1)
  })
}).catch((err) => {
  console.error(`[${new Date().toISOString()}] > Failed to prepare Next.js app:`, err)
  process.exit(1)
})
