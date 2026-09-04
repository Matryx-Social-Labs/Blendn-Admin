import { readFileSync } from "fs"
import { createServer } from "http"
import next from "next"
import { initSocketServer, stopAllOpsBroadcasts } from "./lib/socket-server"
import { stopSponsoredScheduler } from "./lib/sponsored-scheduler"
// #265's import, kept deliberately: the naive resolution drops it and
// `$disconnect()` on shutdown breaks. See docs/MERGE-RUNBOOK.md.
import { db } from "./lib/db"
// The four sweepers are started and stopped as one unit now (#276). Importing
// them individually here is what coupled them to Socket.io in the first place.
import { startBackgroundWork, stopBackgroundWork } from "./lib/background"
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

  /*
   * A deliberate step, not a side effect of the line above.
   *
   * These three sweepers used to start inside `initSocketServer`, so serving
   * the app any way that did not attach a websocket server stopped all of them
   * with no log line -- which renders as occupancy climbing for ever and "the
   * event was quiet". None of them emits over a socket.
   *
   * After Socket.io, because the sponsored scheduler that `initSocketServer`
   * arms does need `io`, and starting these first would only widen the window
   * where the two disagree about whether the process is up.
   */
  startBackgroundWork()
  console.log(`[${new Date().toISOString()}] > Background work started`)

  // Graceful shutdown
  const shutdown = () => {
    console.log(`\n[${new Date().toISOString()}] > Shutting down gracefully...`)
    // Without this the scheduler's pending timeout keeps the event loop alive
    // and the process waits out the forced-exit timeout. #264 moved this out of
    // socket-server, so it is `stopSponsoredScheduler`, not `.stopAll()`.
    stopSponsoredScheduler()
    stopBackgroundWork()
    // The fifth timer. `startOpsBroadcast` arms a 5s interval per event any
    // time someone opens a live ops screen, and this was the one loop the
    // shutdown handler never stopped -- so a deploy during a live event held
    // the event loop open for the full 10s forced-exit timeout and exited 1.
    stopAllOpsBroadcasts()

    // Drain the connection pool. Without this, in-flight queries are abandoned
    // at the forced-exit timeout rather than finished or cleanly cancelled.
    void db.$disconnect().catch(() => {})

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

  /*
   * Where the memory actually is, when something asks.
   *
   * This process reached **6.7GB RSS** on a CI runner and was killed by the
   * host, while `--max-old-space-size=1536` was in force — so the growth is
   * not the V8 old space, and `ps` cannot say what it is instead. The four
   * numbers below can: `heapUsed` is JavaScript objects, `external` is memory
   * V8 accounts for but does not own, `arrayBuffers` is the Buffer/TypedArray
   * share of that, and the gap between `rss` and all of them is native or
   * allocator territory — glibc's per-thread malloc arenas being the usual
   * suspect on Linux, and invisible everywhere else.
   *
   * Off unless asked for, because a long-running server should not narrate
   * itself. On stdout rather than through `logger` so it survives being piped
   * straight into a CI step log — the only channel that outlives a reclaimed
   * runner, since `if: always()` steps and artifact uploads are both skipped.
   */
  if (process.env.MEMORY_TRACE === "1") {
    const mb = (n: number) => Math.round(n / 1024 / 1024)
    const trace = setInterval(() => {
      const m = process.memoryUsage()

      /*
       * `unaccounted` was measured at 93% of a 6.6GB RSS, so the four numbers
       * above have said all they can: it is not the heap and it is not
       * Buffers. These two say where to look next, and they disagree with
       * each other by design.
       *
       * `handles` counts libuv handles — sockets, streams, timers. Each one
       * that leaks holds a native read buffer that `external` never sees,
       * because it is malloc'd rather than allocated as an ArrayBuffer. A
       * count climbing with load is a leaked-connection story.
       *
       * `threads` is read from /proc because worker threads carry their own
       * V8 isolate, and `process.memoryUsage()` reports the CALLING isolate
       * only while `rss` covers the whole process — so a worker's heap is
       * indistinguishable from native memory from here. A climbing thread
       * count is an entirely different bug from a climbing handle count, and
       * only one of them is ours.
       */
      const handles = (process as unknown as {
        _getActiveHandles?: () => unknown[]
      })._getActiveHandles?.() ?? []
      const byType = new Map<string, number>()
      for (const h of handles) {
        const name = (h as { constructor?: { name?: string } })?.constructor?.name ?? "unknown"
        byType.set(name, (byType.get(name) ?? 0) + 1)
      }
      const top = [...byType.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([n, c]) => `${n}:${c}`)
        .join(",")

      let threads = "?"
      try {
        const status = readFileSync("/proc/self/status", "utf8")
        threads = status.match(/^Threads:\s*(\d+)/m)?.[1] ?? "?"
      } catch {
        // Not Linux. The CI runner is, which is where this matters.
      }

      console.log(
        `[memtrace] rss=${mb(m.rss)}M heapUsed=${mb(m.heapUsed)}M ` +
          `heapTotal=${mb(m.heapTotal)}M external=${mb(m.external)}M ` +
          `arrayBuffers=${mb(m.arrayBuffers)}M ` +
          `unaccounted=${mb(m.rss - m.heapTotal - m.external)}M ` +
          `handles=${handles.length} threads=${threads} [${top}]`
      )
    }, 5_000)
    // Unref'd so it never holds the process open — a diagnostic that changes
    // when the server may exit would be measuring itself.
    trace.unref()
  }

  httpServer.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] > HTTP server error:`, err)
    process.exit(1)
  })
}).catch((err) => {
  console.error(`[${new Date().toISOString()}] > Failed to prepare Next.js app:`, err)
  process.exit(1)
})
