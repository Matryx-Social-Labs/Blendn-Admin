"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = require("http");
const next_1 = __importDefault(require("next"));
const socket_server_1 = require("./lib/socket-server");
// Environment configuration
const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = parseInt(process.env.PORT || "3000", 10);
console.log(`[${new Date().toISOString()}] > Server startup initiated`);
console.log(`[${new Date().toISOString()}] > NODE_ENV: ${process.env.NODE_ENV}`);
console.log(`[${new Date().toISOString()}] > PORT: ${port}`);
console.log(`[${new Date().toISOString()}] > HOSTNAME: ${hostname}`);
// Validate critical environment variables in production
if (!dev) {
    const required = ["DATABASE_URL", "NEXTAUTH_SECRET", "MOBILE_JWT_SECRET"];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) {
        console.error(`[${new Date().toISOString()}] ❌ Missing required environment variables: ${missing.join(", ")}`);
        process.exit(1);
    }
    console.log(`[${new Date().toISOString()}] > All required environment variables present`);
}
// Create Next.js app
console.log(`[${new Date().toISOString()}] > Creating Next.js app instance...`);
const app = (0, next_1.default)({ dev, hostname, port });
const handle = app.getRequestHandler();
console.log(`[${new Date().toISOString()}] > Starting server in ${dev ? 'development' : 'production'} mode...`);
console.log(`[${new Date().toISOString()}] > Preparing Next.js app...`);
app.prepare().then(() => {
    console.log(`[${new Date().toISOString()}] > Next.js app prepared successfully`);
    // Create HTTP server
    console.log(`[${new Date().toISOString()}] > Creating HTTP server...`);
    const httpServer = (0, http_1.createServer)((req, res) => {
        handle(req, res);
    });
    console.log(`[${new Date().toISOString()}] > HTTP server created`);
    // Initialize Socket.io
    console.log(`[${new Date().toISOString()}] > Initializing Socket.io...`);
    const io = (0, socket_server_1.initSocketServer)(httpServer);
    console.log(`[${new Date().toISOString()}] > Socket.io initialized`);
    // Graceful shutdown
    const shutdown = () => {
        console.log(`\n[${new Date().toISOString()}] > Shutting down gracefully...`);
        io === null || io === void 0 ? void 0 : io.close(() => {
            console.log(`[${new Date().toISOString()}] > Socket.io closed`);
        });
        httpServer.close(() => {
            console.log(`[${new Date().toISOString()}] > HTTP server closed`);
            process.exit(0);
        });
        // Force exit after 10 seconds
        setTimeout(() => {
            console.error(`[${new Date().toISOString()}] > Forced shutdown after timeout`);
            process.exit(1);
        }, 10000);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    // Start server
    console.log(`[${new Date().toISOString()}] > Starting HTTP server on ${hostname}:${port}...`);
    httpServer.listen(port, hostname, () => {
        console.log(`[${new Date().toISOString()}] > HTTP server listening`);
        console.log(`
╔═══════════════════════════════════════════════════╗
║           Blendn Admin Server Started             ║
╠═══════════════════════════════════════════════════╣
║  Environment: ${(dev ? "development" : "production").padEnd(34)}║
║  URL:         http://${hostname}:${port}${" ".repeat(Math.max(0, 25 - hostname.length - String(port).length))}║
║  Socket.io:   Ready                               ║
╚═══════════════════════════════════════════════════╝
    `);
    });
    httpServer.on('error', (err) => {
        console.error(`[${new Date().toISOString()}] > HTTP server error:`, err);
        process.exit(1);
    });
}).catch((err) => {
    console.error(`[${new Date().toISOString()}] > Failed to prepare Next.js app:`, err);
    process.exit(1);
});
