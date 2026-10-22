/**
 * The bulk bell insert is chunked, and one failing chunk does not take the
 * others' rows with it (lib/push-notifications.ts `recordBulk`).
 */
const createManyAndReturn = jest.fn()
const tokens = jest.fn()
const sentMessages: Array<{ to: string; data: Record<string, string> }> = []

jest.mock("@/lib/db", () => ({
  db: {
    notifications: { createManyAndReturn: (...a: unknown[]) => createManyAndReturn(...a) },
    push_tokens: { findMany: (...a: unknown[]) => tokens(...a) },
  },
}))
jest.mock("expo-server-sdk", () => ({
  Expo: class {
    static isExpoPushToken() {
      return true
    }
    chunkPushNotifications(m: unknown[]) {
      return [m]
    }
    async sendPushNotificationsAsync(chunk: Array<{ to: string; data: Record<string, string> }>) {
      sentMessages.push(...chunk)
      return chunk.map(() => ({ status: "ok", id: "t" }))
    }
  },
}))
const warn = jest.fn()
jest.mock("@/lib/logger", () => ({ logger: { warn: (...a: unknown[]) => warn(...a), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }))

import { BELL_INSERT_CHUNK as REAL_CHUNK, sendBulkPushNotifications } from "@/lib/push-notifications"

// The limit is written out here, not read from the module: a test that builds its audience from the constant it checks hangs when that constant is wrong.
const BELL_INSERT_CHUNK = 5000

const people = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`)
const rowsFor = (args: { data: Array<{ user_id: string }> }) => args.data.map((d) => ({ id: `row-${d.user_id}`, user_id: d.user_id }))

beforeEach(() => {
  createManyAndReturn.mockReset()
  tokens.mockReset().mockResolvedValue([])
  warn.mockReset()
  sentMessages.length = 0
  delete (globalThis as { __blendnSocketIo?: unknown }).__blendnSocketIo
})

const send = (userIds: string[]) =>
  sendBulkPushNotifications({ userIds, title: "t", body: "b", data: { type: "announcement", eventId: "e1" } })

describe("the bulk bell insert", () => {
  it("is 5,000 rows to a statement", () => {
    expect(REAL_CHUNK).toBe(BELL_INSERT_CHUNK)
  })

  it("is one statement up to the chunk size and splits above it, every recipient exactly once", async () => {
    createManyAndReturn.mockImplementation(async (a) => rowsFor(a))
    await send(people(BELL_INSERT_CHUNK))
    expect(createManyAndReturn).toHaveBeenCalledTimes(1)

    createManyAndReturn.mockClear()
    const all = people(BELL_INSERT_CHUNK * 2 + 7)
    await send(all)
    expect(createManyAndReturn.mock.calls.map(([a]) => a.data.length)).toEqual([BELL_INSERT_CHUNK, BELL_INSERT_CHUNK, 7])
    const written = createManyAndReturn.mock.calls.flatMap(([a]) => a.data.map((d: { user_id: string }) => d.user_id))
    expect(written).toEqual(all)
  })

  it("a failing chunk is logged and skipped; the chunks that succeeded keep their rows and their pushes carry the id", async () => {
    createManyAndReturn
      .mockImplementationOnce(async (a) => rowsFor(a))
      .mockRejectedValueOnce(new Error("statement timeout"))
      .mockImplementationOnce(async (a) => rowsFor(a))
    const all = people(BELL_INSERT_CHUNK * 2 + 3)
    // Somebody from each chunk has a device.
    const devices = [all[0], all[BELL_INSERT_CHUNK + 1], all[BELL_INSERT_CHUNK * 2 + 1]]
    tokens.mockResolvedValue(devices.map((u) => ({ user_id: u, token: `ExponentPushToken[${u}]`, channel_set: null })))

    await expect(send(all)).resolves.toMatchObject({ sent: 3 })

    expect(createManyAndReturn).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledWith(
      "Failed to record a chunk of bulk notifications",
      expect.objectContaining({ chunkStart: BELL_INSERT_CHUNK, chunkSize: BELL_INSERT_CHUNK, total: all.length })
    )
    const idOf = (u: string) => sentMessages.find((m) => m.to === `ExponentPushToken[${u}]`)?.data.notificationId
    expect(idOf(devices[0])).toBe(`row-${devices[0]}`)
    expect(idOf(devices[1])).toBeUndefined() // its chunk failed: pushed without a row id, not dropped
    expect(idOf(devices[2])).toBe(`row-${devices[2]}`)
  })

  it("announces to the bell only the recipients whose rows were written", async () => {
    const emit = jest.fn()
    ;(globalThis as { __blendnSocketIo?: unknown }).__blendnSocketIo = { to: (rooms: string[]) => ({ emit: (...a: unknown[]) => emit(rooms, ...a) }) }
    createManyAndReturn.mockRejectedValueOnce(new Error("boom")).mockImplementationOnce(async (a) => rowsFor(a))
    await send(people(BELL_INSERT_CHUNK + 2))
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0][0]).toEqual([`user:u${BELL_INSERT_CHUNK}`, `user:u${BELL_INSERT_CHUNK + 1}`])
  })
})
