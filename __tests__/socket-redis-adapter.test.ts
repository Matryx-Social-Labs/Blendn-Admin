import { Server as HttpServer } from "http"

/**
 * The Socket.io Redis adapter is opt-in (SCRUM-1217). Attached whenever
 * `REDIS_URL` was set, it made every `fetchSockets` ask Redis first even on one
 * replica, so a Redis restart froze every room emit. One replica uses the
 * in-memory adapter; `SOCKET_REDIS_ADAPTER=1` is for the day there are two.
 */
// Hands back the in-memory adapter: socket.io constructs whatever this returns.
const createAdapter = jest.fn(() => jest.requireActual("socket.io-adapter").Adapter)
jest.mock("@socket.io/redis-adapter", () => ({ createAdapter }))

const pubClient = { on: jest.fn(), connect: jest.fn(async () => undefined), duplicate: () => subClient }
const subClient = { on: jest.fn(), connect: jest.fn(async () => undefined) }
const createClient = jest.fn(() => pubClient)
jest.mock("redis", () => ({ createClient }))
jest.mock("@/lib/sponsored-scheduler", () => ({ startSponsoredScheduler: jest.fn() }))
// `jose` is ESM-only and this runtime cannot require() it; the handshake is not under test here.
jest.mock("@/lib/mobile-auth", () => ({ verifyAccessToken: jest.fn(), accountBlockReason: jest.fn() }))

import { initSocketServer } from "@/lib/socket-server"

const settle = () => new Promise((r) => setTimeout(r, 50))

beforeEach(() => {
  jest.clearAllMocks()
  process.env.REDIS_URL = "redis://fake:6379"
  delete process.env.SOCKET_REDIS_ADAPTER
})
afterAll(() => {
  delete process.env.REDIS_URL
  delete process.env.SOCKET_REDIS_ADAPTER
})

it("stays in memory with REDIS_URL set and no SOCKET_REDIS_ADAPTER", async () => {
  const io = initSocketServer(new HttpServer())
  await settle()
  expect(createClient).not.toHaveBeenCalled()
  expect(createAdapter).not.toHaveBeenCalled()
  io.close()
})

it("with SOCKET_REDIS_ADAPTER=1 attaches it, a 1 s request timeout, and an error listener on both clients", async () => {
  process.env.SOCKET_REDIS_ADAPTER = "1"
  const io = initSocketServer(new HttpServer())
  await settle()
  expect(createAdapter).toHaveBeenCalledWith(pubClient, subClient, { requestsTimeout: 1000 })
  // Without one, an emitted 'error' is an unhandled exception that takes the process down.
  expect(pubClient.on).toHaveBeenCalledWith("error", expect.any(Function))
  expect(subClient.on).toHaveBeenCalledWith("error", expect.any(Function))
  io.close()
})
