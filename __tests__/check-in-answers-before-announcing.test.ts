/*
 * The door answers once the check-in is written; the room hears of the
 * arrival after. The broadcast's reads (the pseudonym, who they are, their
 * blocks) used to sit in front of the response, so the person holding the
 * pass waited on them. Here they are held open, and the seat must still come
 * back — with the broadcast still pending, not skipped; and once they resolve
 * the arrival goes out as before, failures logged, and a checkout right behind
 * it waits for it.
 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

const mockDb = {
  organisation_members: { findMany: jest.fn().mockResolvedValue([]) },
  event_check_ins: {
    upsert: jest.fn().mockResolvedValue({ id: "ci1", status: "checked_in" }),
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  event_match_preferences: { upsert: jest.fn().mockResolvedValue({ intent: [] }) },
  chat_groups: { findUnique: jest.fn().mockResolvedValue({ id: "room1" }) },
  chat_group_members: {
    findUnique: jest.fn().mockResolvedValue({ status: "active", last_allowed_at: null, anonymous_name: "Quiet Fox" }),
    updateMany: jest.fn(),
  },
  user: { findUnique: jest.fn() },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/conversations", () => ({ blockCounterparties: jest.fn() }))
jest.mock("@/lib/socket-server", () => ({ emitEventCheckIn: jest.fn(async () => {}), emitEventCheckOut: jest.fn(), evictFromVenueDay: jest.fn() }))
jest.mock("@/lib/presence-sessions", () => ({ openSession: jest.fn().mockResolvedValue(undefined), closeSession: jest.fn().mockResolvedValue(undefined) }))
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))

import { seatAtTheDoor } from "@/lib/check-in-core"
import { performCheckout } from "@/lib/checkout"
import { blockCounterparties } from "@/lib/conversations"
import { logger } from "@/lib/logger"
import { emitEventCheckIn, emitEventCheckOut } from "@/lib/socket-server"

const settle = () => new Promise((r) => setImmediate(r))
const seat = (extending = false) =>
  seatAtTheDoor({
    event: { id: "ev1", kind: "event", title: "T", venue_name: null, organizer_org_id: null, venue: null },
    occurrenceId: "occ1",
    userId: "u1",
    profile: { onboarded: true, age: 25, date_of_birth: null, intent_default: [], reveal_by_default: false },
    point: { lat: 12.9, lng: 77.6 },
    deviceInfo: undefined,
    now: new Date(),
    extending,
  })

let arriver: ReturnType<typeof deferred<unknown>>
let blocks: ReturnType<typeof deferred<string[]>>

beforeEach(() => {
  jest.clearAllMocks()
  arriver = deferred()
  blocks = deferred()
  mockDb.user.findUnique.mockReturnValue(arriver.promise)
  ;(blockCounterparties as jest.Mock).mockReturnValue(blocks.promise)
})

it("answers without waiting for the arrival's broadcast", async () => {
  const result = await seat()

  expect(result.checkIn.id).toBe("ci1")
  expect(result.chatGroupId).toBe("room1")
  // Started, so the room still hears it — but not finished, and not awaited.
  expect(blockCounterparties).toHaveBeenCalledWith("u1")
  expect(emitEventCheckIn).not.toHaveBeenCalled()
})

it("announces the arrival as before once the reads come back", async () => {
  await seat()
  arriver.resolve({ name: "Asha", profile: { photos: ["p.jpg"], show_online: false } })
  blocks.resolve(["blocked-1"])
  await settle()
  expect(emitEventCheckIn).toHaveBeenCalledWith("ev1", "u1", "Quiet Fox", { name: "Asha", image: "p.jpg" }, ["blocked-1"], false)
})

it("logs a failed announcement and never throws it", async () => {
  await seat()
  blocks.reject(new Error("db gone"))
  arriver.resolve(null)
  await settle()
  expect(emitEventCheckIn).not.toHaveBeenCalled()
  expect(logger.error).toHaveBeenCalledWith("Announcing an arrival failed", { eventId: "ev1", error: "db gone" })
})

it("announces nothing when the window only moved (a Go Live extended)", async () => {
  await seat(true)
  expect(blockCounterparties).not.toHaveBeenCalled()
})

it("a checkout right behind the arrival waits for it: the room never hears the leaving first", async () => {
  await seat()
  mockDb.event_check_ins.findUnique.mockResolvedValue({
    id: "ci1",
    event_id: "ev1",
    user_id: "u1",
    status: "checked_in",
    occurrence_id: "occ1",
    event: { kind: "event" },
  })
  const out = performCheckout("ci1", "manual")
  await settle()
  expect(emitEventCheckOut).not.toHaveBeenCalled()

  arriver.resolve(null)
  blocks.resolve([])
  await out
  const checkedIn = (emitEventCheckIn as jest.Mock).mock.invocationCallOrder[0]
  const checkedOut = (emitEventCheckOut as jest.Mock).mock.invocationCallOrder[0]
  expect(checkedIn).toBeLessThan(checkedOut)
})
