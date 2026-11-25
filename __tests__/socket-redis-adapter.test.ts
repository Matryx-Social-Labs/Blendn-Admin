import { Server as HttpServer } from "http"

/**
 * The Socket.io Redis adapter is opt-in (SCRUM-1217). Attached whenever
 * `REDIS_URL` was set, it made every `fetchSockets` ask Redis first even on one
 * replica, so a Redis restart froze every room emit. One replica uses the
 * in-memory adapter; `SOCKET_REDIS_ADAPTER=1` is for the day there are two.
 */
// Hands back the in-memory adapter: socket.io constructs whatever this returns.
const mockCreateAdapter = jest.fn(() => jest.requireActual("socket.io-adapter").Adapter)
jest.mock("@socket.io/redis-adapter", () => ({ createAdapter: mockCreateAdapter }))

const mockPubClient = { on: jest.fn(), connect: jest.fn(async () => undefined), duplicate: () => mockSubClient }
const mockSubClient = { on: jest.fn(), connect: jest.fn(async () => undefined) }
const mockCreateClient = jest.fn(() => mockPubClient)
jest.mock("redis", () => ({ createClient: mockCreateClient }))
jest.mock("@/lib/sponsored-scheduler", () => ({ startSponsoredScheduler: jest.fn() }))
// `jose` is ESM-only and this runtime cannot require() it; the handshake is not under test here.
jest.mock("@/lib/mobile-auth", () => ({ verifyAccessToken: jest.fn(), accountBlockReason: jest.fn() }))

import { initSocketServer } from "@/lib/socket-server"

/** The attach runs in a detached async block: wait for it rather than a fixed sleep. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 10))
}

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
  // The same wait as the attach below takes, so "not called" is not merely "not yet".
  await until(() => mockCreateClient.mock.calls.length > 0)
  expect(mockCreateClient).not.toHaveBeenCalled()
  expect(mockCreateAdapter).not.toHaveBeenCalled()
  io.close()
})

it("with SOCKET_REDIS_ADAPTER=1 attaches it, a 1 s request timeout, and an error listener on both clients", async () => {
  process.env.SOCKET_REDIS_ADAPTER = "1"
  const io = initSocketServer(new HttpServer())
  await until(() => mockCreateAdapter.mock.calls.length > 0)
  expect(mockCreateAdapter).toHaveBeenCalledWith(mockPubClient, mockSubClient, { requestsTimeout: 1000 })
  // Without one, an emitted 'error' is an unhandled exception that takes the process down.
  expect(mockPubClient.on).toHaveBeenCalledWith("error", expect.any(Function))
  expect(mockSubClient.on).toHaveBeenCalledWith("error", expect.any(Function))
  io.close()
})
