import { createServer } from "http"
import next from "next"
import { initSocketServer } from "./lib/socket-server"

const dev = process.env.NODE_ENV !== "production"
const hostname = "localhost"
const port = parseInt(process.env.PORT || "3000", 10)

// Create Next.js app
const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  // Create HTTP server
  const httpServer = createServer((req, res) => {
    handle(req, res)
  })

  // Initialize Socket.io
  initSocketServer(httpServer)

  // Start server
  httpServer.listen(port, () => {
    console.log(
      `> Server listening on http://${hostname}:${port} as ${
        dev ? "development" : process.env.NODE_ENV
      }`
    )
    console.log("> Socket.io server ready")
  })
})
