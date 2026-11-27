/*
 * When the Live tab's socket counts as lost, and when it is back (SCRUM-1348).
 *
 * The rule: Socket.io retries a dropped transport by itself, about a second
 * later. A drop that comes back on that first retry never shows the line (a
 * phone handing over between networks, a deploy's blip). The first retry that
 * fails is a `connect_error`, and that is when the screen says so. A close
 * Socket.io will not retry (`socket.active` false: the server sent DISCONNECT,
 * as `evictUserSockets` does) is stale at once, and is retried by hand so
 * "reconnecting" stays true. And a socket that stops answering without
 * closing (walking out of the venue's wifi) is only noticed by Socket.io's
 * ping, 85 s on (measured): snapshots come every tick, so four missed ticks
 * (20 s) go stale too, and the join is asked again; the socket is left to
 * Socket.io (SCRUM-1444). The next `ops:snapshot` clears it, whichever it was.
 *
 * This mock checks the hook's own rules. Whether Socket.io then reconnects is
 * `use-ops-snapshot-reconnect.test.ts`, against a real server: this mock
 * once certified a watchdog that stopped Socket.io's retries for good.
 *
 * There is no DOM test renderer in this repo (jest runs in node), so React's
 * two hooks are stood in for: the effect runs once, the setters are recorded.
 */

type Handler = (...args: unknown[]) => void

const state: Record<string, unknown> = {}
jest.mock("react", () => {
  const slots = ["snapshot", "status"] as const
  let call = 0
  return {
    useState: (initial: unknown) => {
      const key = slots[call++ % 2]
      state[key] = initial
      return [initial, (v: unknown) => (state[key] = v)]
    },
    useEffect: (effect: () => (() => void) | void) => {
      cleanups.push(effect() ?? (() => {}))
    },
  }
})
const cleanups: Array<() => void> = []

const socket = {
  handlers: new Map<string, Handler>(),
  active: true,
  connected: true,
  on(event: string, handler: Handler) {
    this.handlers.set(event, handler)
    return this
  },
  emit: jest.fn(),
  connect: jest.fn(),
  // As Socket.io's own: a client-side disconnect is a "disconnect" it will not retry.
  disconnect: jest.fn(function (this: { active: boolean; fire: (e: string, ...a: unknown[]) => void }) {
    this.active = false
    this.fire("disconnect", "io client disconnect")
    return this
  }),
  fire(event: string, ...args: unknown[]) {
    this.handlers.get(event)?.(...args)
  },
}
jest.mock("socket.io-client", () => ({ io: () => socket }))

import { OPS_INTERVAL_MS } from "@/lib/live-metrics"
import { useOpsSnapshot } from "@/lib/use-ops-snapshot"

const mockStatus = () => state.status
const joins = () => socket.emit.mock.calls.filter(([event]) => event === "join:eventOps").length
const snapshot = { eventId: "e1", at: "2026-11-26T17:11:00.000Z" }

beforeEach(() => {
  jest.useFakeTimers()
  socket.handlers.clear()
  socket.active = true
  socket.connected = true
  socket.connect.mockClear()
  socket.disconnect.mockClear()
  socket.emit.mockClear()
  useOpsSnapshot("e1", true)
  socket.fire("connect")
  socket.fire("ops:snapshot", snapshot)
  expect(state.status).toBe("live")
})

afterEach(() => {
  cleanups.splice(0).forEach((c) => c())
  jest.useRealTimers()
})

describe("useOpsSnapshot after the first snapshot", () => {
  it("does not flash on a drop that comes back on its first retry", () => {
    socket.fire("disconnect", "transport close")
    expect(state.status).toBe("live")
    socket.fire("connect")
    socket.fire("ops:snapshot", snapshot)
    expect(state.status).toBe("live")
  })

  it("goes stale on the first failed retry, and the next snapshot clears it", () => {
    socket.fire("disconnect", "transport close")
    socket.fire("connect_error", new Error("xhr poll error"))
    expect(state.status).toBe("error")
    // Back: the join answers with a snapshot at once.
    socket.fire("connect")
    expect(state.status).toBe("error")
    socket.fire("ops:snapshot", snapshot)
    expect(state.status).toBe("live")
  })

  it("goes stale at once on a close Socket.io will not retry, and retries it by hand", () => {
    socket.active = false
    socket.fire("disconnect", "io server disconnect")
    expect(state.status).toBe("error")
    expect(socket.connect).toHaveBeenCalledTimes(1)
    socket.fire("ops:snapshot", snapshot)
    expect(state.status).toBe("live")
  })

  it("goes stale after four missed ticks on a socket that never closed", () => {
    jest.advanceTimersByTime(4 * OPS_INTERVAL_MS - 1)
    expect(mockStatus()).toBe("live")
    jest.advanceTimersByTime(1)
    expect(mockStatus()).toBe("error")
    // Asked again; the socket is left to Socket.io, which a disconnect() would stop (SCRUM-1444).
    expect(joins()).toBe(2)
    expect(socket.disconnect).not.toHaveBeenCalled()
    expect(socket.connect).not.toHaveBeenCalled()
    socket.fire("ops:snapshot", snapshot)
    expect(mockStatus()).toBe("live")
  })

  it("goes stale after four missed ticks while Socket.io is retrying, and leaves the retries alone", () => {
    socket.connected = false
    socket.fire("disconnect", "transport close")
    jest.advanceTimersByTime(4 * OPS_INTERVAL_MS)
    expect(mockStatus()).toBe("error")
    // Not asked on a closed socket: Socket.io would buffer it, and the connect handler asks anyway.
    expect(joins()).toBe(1)
    expect(socket.disconnect).not.toHaveBeenCalled()
  })

  it("is not stale while the ticks keep coming", () => {
    // A slow tick (a large room's query) is late, not lost: still live just before each lands.
    for (let tick = 0; tick < 10; tick++) {
      jest.advanceTimersByTime(3 * OPS_INTERVAL_MS)
      expect(mockStatus()).toBe("live")
      socket.fire("ops:snapshot", snapshot)
    }
  })

  it("leaves a refusal alone: a rejoin the server refuses stays denied", () => {
    socket.fire("error", { message: "Not authorized to watch this event", code: "OPS_FORBIDDEN" })
    jest.advanceTimersByTime(10 * OPS_INTERVAL_MS)
    expect(mockStatus()).toBe("denied")
    expect(socket.disconnect).not.toHaveBeenCalled()
  })

  it("treats a join the server could not answer as stale, and asks again after four ticks (SCRUM-1402)", () => {
    // The database did not answer the access check (a saturated pool): not a refusal.
    socket.fire("error", { message: "Could not join right now. Try again.", code: "SERVER_ERROR" })
    expect(mockStatus()).toBe("error")
    jest.advanceTimersByTime(4 * OPS_INTERVAL_MS)
    expect(socket.emit).toHaveBeenLastCalledWith("join:eventOps", "e1")
    expect(joins()).toBe(2)
    expect(socket.disconnect).not.toHaveBeenCalled()
    socket.fire("ops:snapshot", snapshot)
    expect(mockStatus()).toBe("live")
  })

  it("asks again when the very first join could not be checked, before any snapshot", () => {
    // A fresh screen: the beforeEach one closed, its own disconnect not counted.
    cleanups.splice(0).forEach((c) => c())
    socket.handlers.clear()
    socket.active = true
    socket.connect.mockClear()
    socket.disconnect.mockClear()
    socket.emit.mockClear()
    useOpsSnapshot("e1", true)
    socket.fire("connect")
    socket.fire("error", { message: "Could not join right now. Try again.", code: "SERVER_ERROR" })
    expect(mockStatus()).toBe("error")
    jest.advanceTimersByTime(4 * OPS_INTERVAL_MS)
    expect(joins()).toBe(2)
    expect(socket.disconnect).not.toHaveBeenCalled()
  })

  it("is not cleared by another event's snapshot", () => {
    socket.fire("connect_error", new Error("timeout"))
    socket.fire("ops:snapshot", { ...snapshot, eventId: "e2" })
    expect(mockStatus()).toBe("error")
  })

  it("keeps the old figures while stale: the screen says they are from then", () => {
    socket.fire("connect_error", new Error("timeout"))
    expect(state.snapshot).toBe(snapshot)
  })

  it("says nothing once the screen has closed it", () => {
    cleanups.splice(0).forEach((c) => c())
    // No timer outlives the screen (the socket is mocked: every timer here is the hook's).
    expect(jest.getTimerCount()).toBe(0)
    jest.advanceTimersByTime(10 * OPS_INTERVAL_MS)
    socket.active = false
    socket.fire("disconnect", "io client disconnect")
    expect(state.status).toBe("live")
    expect(socket.connect).not.toHaveBeenCalled()
  })
})
