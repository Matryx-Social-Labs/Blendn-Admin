/*
 * The Live tab's hook against a real Socket.io server and the real client
 * (SCRUM-1444): whatever the outage, the figures come back by themselves.
 *
 * Why real: #1086's quiet watchdog called `socket.disconnect()` 20 s after the
 * last snapshot. With the transport already gone, Socket.io is mid-retry, and a
 * manual disconnect then stops those retries for good and fires no
 * `disconnect` event (socket.io-client `Socket.disconnect` → `destroy` →
 * `Manager._close`: `skipReconnect = true`). The mocked suite certified it,
 * because its mock fired `disconnect` on every call. On staging an outage of
 * 20 s or more left "reconnecting" on screen until a reload.
 *
 * The server here stands in for `joinEventOps` and the 5 s broadcast loop only:
 * join → one snapshot, then one per tick; `evictUserSockets` is
 * `disconnectSockets(true)`, as there. An outage cuts every TCP connection and
 * stops listening, then listens again on the same port.
 *
 * Real time throughout (fake timers would replace the transport's own): the
 * cases run concurrently, about two minutes in all.
 */
import { createServer, type Server as HttpServer } from "node:http"
import type { AddressInfo, Socket as NetSocket } from "node:net"
import { Server } from "socket.io"
import type { Socket } from "socket.io-client"

import { OPS_INTERVAL_MS } from "@/lib/live-metrics"

const QUIET_MS = 4 * OPS_INTERVAL_MS

type Seen = {
  status: unknown
  snapshots: number
  unmount: () => void
  client: Socket
}

// React's two hooks, stood in for per mount: the effect runs once, the setters are recorded.
let mockSeen: Seen
let mockSlot = 0
jest.mock("react", () => ({
  useState: (initial: unknown) => {
    const seen = mockSeen
    const isStatus = mockSlot++ % 2 === 1
    if (isStatus) seen.status = initial
    return [
      initial,
      (value: unknown) => {
        if (isStatus) seen.status = value
        else seen.snapshots++
      },
    ]
  },
  useEffect: (effect: () => (() => void) | void) => {
    mockSeen.unmount = effect() ?? (() => {})
  },
}))

// The real client, pointed at this test's server (the hook is same-origin in a browser).
let mockUrl = ""
let mockClient: Socket | undefined
jest.mock("socket.io-client", () => {
  const real = jest.requireActual("socket.io-client")
  return {
    ...real,
    io: (opts: object) => (mockClient = real.io(mockUrl, { ...opts, forceNew: true })),
  }
})

import { useOpsSnapshot } from "@/lib/use-ops-snapshot"

// Every quiet timer the hook starts, so the end can say none outlived its screen.
const quietTimers = new Set<unknown>()
const realSetTimeout = global.setTimeout
const realClearTimeout = global.clearTimeout
jest.spyOn(global, "setTimeout").mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
  if (ms !== QUIET_MS) return realSetTimeout(fn, ms, ...args)
  const handle = realSetTimeout(() => {
    quietTimers.delete(handle)
    fn(...args)
  }, ms)
  quietTimers.add(handle)
  return handle
}) as typeof setTimeout)
jest.spyOn(global, "clearTimeout").mockImplementation((handle) => {
  quietTimers.delete(handle)
  realClearTimeout(handle)
})

const sleep = (ms: number) => new Promise((resolve) => realSetTimeout(resolve, ms))

async function waitFor(what: string, check: () => boolean, ms = 15_000) {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

type Join = "snapshot" | "SERVER_ERROR" | "OPS_FORBIDDEN"

/** One event's live operations, as `joinEventOps` and the broadcast loop serve them. */
// Whatever a case leaves open when it fails is closed here, so a red run ends.
const servers = new Set<() => Promise<void>>()
const screens = new Set<() => void>()

function opsServer() {
  const world = {
    port: 0,
    connections: 0,
    joins: 0,
    emitting: true,
    // How the next joins are answered, in order; then with a snapshot.
    answers: [] as Join[],
    http: undefined as HttpServer | undefined,
    io: undefined as Server | undefined,
    tick: undefined as ReturnType<typeof setInterval> | undefined,
    tcp: new Set<NetSocket>(),
  }
  const snapshot = () => ({ eventId: "e1", at: new Date().toISOString() })

  async function start() {
    const http = createServer()
    http.on("connection", (s) => {
      world.tcp.add(s)
      s.on("close", () => world.tcp.delete(s))
    })
    const io = new Server(http)
    io.on("connection", (socket) => {
      world.connections++
      socket.on("join:eventOps", () => {
        world.joins++
        // As `joinEventOps`: out of the room first, whatever the answer is now.
        socket.leave("ops")
        const answer = world.answers.shift() ?? "snapshot"
        if (answer !== "snapshot") {
          socket.emit("error", { message: "no", code: answer })
          return
        }
        socket.join("ops")
        if (world.emitting) socket.emit("ops:snapshot", snapshot())
      })
    })
    world.tick = setInterval(() => {
      if (world.emitting) io.to("ops").emit("ops:snapshot", snapshot())
    }, OPS_INTERVAL_MS)
    await new Promise<void>((resolve) => http.listen(world.port, "127.0.0.1", resolve))
    world.port = (http.address() as AddressInfo).port
    world.http = http
    world.io = io
  }
  servers.add(stop)

  /** The network goes: every connection cut, nothing listening. */
  async function stop() {
    if (!world.io) return
    const io = world.io
    world.io = undefined
    clearInterval(world.tick)
    world.tcp.forEach((s) => s.destroy())
    await new Promise<void>((resolve) => io.close(() => resolve()))
  }

  /** `evictUserSockets`: the server closes the socket, which Socket.io will not retry by itself. */
  function evict() {
    world.io!.disconnectSockets(true)
  }

  const open = () => world.io?.of("/").sockets.size ?? 0

  return { world, start, stop, evict, open }
}

type Ops = ReturnType<typeof opsServer>

async function mount(server: Ops): Promise<Seen> {
  mockUrl = `http://127.0.0.1:${server.world.port}`
  mockSeen = { status: undefined, snapshots: 0, unmount: () => {}, client: undefined as unknown as Socket }
  mockSlot = 0
  const seen = mockSeen
  useOpsSnapshot("e1", true)
  seen.client = mockClient!
  screens.add(() => seen.unmount())
  await waitFor("the first snapshot", () => seen.status === "live" && seen.snapshots > 0)
  return seen
}

/** Back by itself: a snapshot after `since`, and the line cleared. */
async function recovers(seen: Seen, since: number, ms = 15_000) {
  await waitFor("snapshots again", () => seen.snapshots > since && seen.status === "live", ms)
}

/** Closed with the screen: no socket open at the server, none retrying, nothing reconnects later. */
async function unmountLeavesNothing(server: Ops, seen: Seen) {
  seen.unmount()
  await waitFor("the server to see the socket go", () => server.open() === 0, 5_000)
  expect(seen.client.active).toBe(false)
  expect(seen.client.connected).toBe(false)
  const connections = server.world.connections
  // Past Socket.io's longest backoff (5 s, +50 % jitter).
  await sleep(8_000)
  expect(server.world.connections).toBe(connections)
}

/** Reconnect attempts the client makes, counted from the manager. */
function countAttempts(seen: Seen) {
  const counter = { attempts: 0 }
  seen.client.io.on("reconnect_attempt", () => counter.attempts++)
  return counter
}

async function outage(ms: number) {
  const server = opsServer()
  await server.start()
  const seen = await mount(server)
  const counter = countAttempts(seen)

  await server.stop()
  await sleep(ms)
  // The line is up while the server is gone (the first failed retry, SCRUM-1348).
  expect(seen.status).toBe("error")
  const before = seen.snapshots
  await server.start()
  await recovers(seen, before)
  // Socket.io's own backoff (1 s doubling to 5 s), not a storm.
  expect(counter.attempts).toBeLessThanOrEqual(Math.ceil(ms / 2_500) + 3)

  await unmountLeavesNothing(server, seen)
  await server.stop()
}

describe("useOpsSnapshot against a real Socket.io server (SCRUM-1444)", () => {
  afterAll(async () => {
    screens.forEach((unmount) => unmount())
    await Promise.all([...servers].map((stop) => stop()))
    // Every quiet timer either fired or was cleared by its screen.
    expect(quietTimers.size).toBe(0)
  })

  test.concurrent("a 4 s outage: snapshots resume", () => outage(4_000), 60_000)

  test.concurrent("a 25 s outage, past the quiet watchdog: snapshots resume", () => outage(25_000), 90_000)

  test.concurrent("a 90 s outage: snapshots resume", () => outage(90_000), 150_000)

  test.concurrent("the server closes a healthy socket: reopened by hand, snapshots resume", async () => {
    const server = opsServer()
    await server.start()
    const seen = await mount(server)

    const before = seen.snapshots
    server.evict()
    await recovers(seen, before)
    expect(server.world.connections).toBe(2)

    await unmountLeavesNothing(server, seen)
    await server.stop()
  }, 60_000)

  test.concurrent("the server closes the socket and then goes for 25 s: snapshots resume", async () => {
    const server = opsServer()
    await server.start()
    const seen = await mount(server)

    server.evict()
    await server.stop()
    await sleep(25_000)
    expect(seen.status).toBe("error")
    const before = seen.snapshots
    await server.start()
    await recovers(seen, before)

    await unmountLeavesNothing(server, seen)
    await server.stop()
  }, 90_000)

  test.concurrent("an open socket with no snapshot for 25 s: the line shows, then clears, on one connection", async () => {
    const server = opsServer()
    await server.start()
    const seen = await mount(server)

    server.world.emitting = false
    await sleep(QUIET_MS + 1_000)
    expect(seen.status).toBe("error")
    await sleep(25_000 - QUIET_MS - 1_000)
    const before = seen.snapshots
    server.world.emitting = true
    await recovers(seen, before, 2 * OPS_INTERVAL_MS)
    // Left alone: no reconnect for a socket that never closed.
    expect(server.world.connections).toBe(1)

    await unmountLeavesNothing(server, seen)
    await server.stop()
  }, 90_000)

  test.concurrent("a join the server could not check is asked again after four ticks (SCRUM-1402)", async () => {
    const server = opsServer()
    await server.start()
    server.world.answers = ["SERVER_ERROR"]
    mockUrl = `http://127.0.0.1:${server.world.port}`
    mockSeen = { status: undefined, snapshots: 0, unmount: () => {}, client: undefined as unknown as Socket }
    mockSlot = 0
    const seen = mockSeen
    useOpsSnapshot("e1", true)
    seen.client = mockClient!
    screens.add(() => seen.unmount())

    await waitFor("the line", () => seen.status === "error", 5_000)
    await recovers(seen, 0, QUIET_MS + 5_000)
    expect(server.world.joins).toBe(2)

    await unmountLeavesNothing(server, seen)
    await server.stop()
  }, 60_000)

  test.concurrent("a refusal stays denied and is not asked again", async () => {
    const server = opsServer()
    await server.start()
    const seen = await mount(server)

    server.world.answers = ["OPS_FORBIDDEN"]
    // The access changed: a rejoin (as after a reconnect) is refused.
    seen.client.emit("join:eventOps", "e1")
    await waitFor("denied", () => seen.status === "denied", 5_000)
    await sleep(QUIET_MS + 2_000)
    expect(seen.status).toBe("denied")
    expect(server.world.joins).toBe(2)

    await unmountLeavesNothing(server, seen)
    await server.stop()
  }, 60_000)

  test.concurrent("closed mid-outage: nothing retries, nothing reconnects when the server is back", async () => {
    const server = opsServer()
    await server.start()
    const seen = await mount(server)

    await server.stop()
    await sleep(3_000)
    seen.unmount()
    expect(seen.client.active).toBe(false)
    const connections = server.world.connections
    await server.start()
    await sleep(8_000)
    expect(server.world.connections).toBe(connections)
    expect(server.open()).toBe(0)
    await server.stop()
  }, 60_000)

  test.concurrent("closed while quiet: the watchdog goes with it", async () => {
    const server = opsServer()
    await server.start()
    const seen = await mount(server)
    server.world.emitting = false
    await sleep(2_000)
    await unmountLeavesNothing(server, seen)
    await server.stop()
  }, 60_000)
})
