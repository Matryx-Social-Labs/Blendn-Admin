import { createServer } from "http"
import next from "next"
import { initSocketServer } from "./lib/socket-server"

// Environment configuration
const dev = process.env.NODE_ENV !== "production"
const hostname = process.env.HOSTNAME || "0.0.0.0"
const port = parseInt(process.env.PORT || "3000", 10)

// Validate critical environment variables in production
if (!dev) {
  const required = ["DATABASE_URL", "NEXTAUTH_SECRET", "MOBILE_JWT_SECRET"]
  const missing = required.filter((key) => !process.env[key])
  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.join(", ")}`)
    process.exit(1)
  }
}

// Create Next.js app
const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  // Create HTTP server
  const httpServer = createServer((req, res) => {
    handle(req, res)
  })

  // Initialize Socket.io
  const io = initSocketServer(httpServer)

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n> Shutting down gracefully...")
    io?.close(() => {
      console.log("> Socket.io closed")
    })
    httpServer.close(() => {
      console.log("> HTTP server closed")
      process.exit(0)
    })

    // Force exit after 10 seconds
    setTimeout(() => {
      console.error("> Forced shutdown after timeout")
      process.exit(1)
    }, 10000)
  }

  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)

  // Start server
  httpServer.listen(port, hostname, () => {
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
})
