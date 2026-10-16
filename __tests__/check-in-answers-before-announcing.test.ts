/*
 * The door answers once the check-in is written; the room hears of the
 * arrival after. The broadcast's reads (the pseudonym, who they are, their
 * blocks) used to sit in front of the response, so the person holding the
 * pass waited on them. Here they never finish, and the seat must still come
 * back — with the broadcast still pending, not skipped.
 */
const never = () => new Promise<never>(() => {})

const mockDb = {
  organisation_members: { findMany: jest.fn().mockResolvedValue([]) },
  event_check_ins: { upsert: jest.fn().mockResolvedValue({ id: "ci1", status: "checked_in" }) },
  event_match_preferences: { upsert: jest.fn().mockResolvedValue({ intent: [] }) },
  chat_groups: { findUnique: jest.fn().mockResolvedValue({ id: "room1" }) },
  chat_group_members: {
    findUnique: jest.fn().mockResolvedValue({ status: "active", last_allowed_at: null, anonymous_name: "Quiet Fox" }),
  },
  user: { findUnique: jest.fn(never) },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/conversations", () => ({ blockCounterparties: jest.fn(never) }))
jest.mock("@/lib/socket-server", () => ({ emitEventCheckIn: jest.fn() }))
jest.mock("@/lib/checkout", () => ({ checkOutOfOtherEvents: jest.fn().mockResolvedValue([]) }))
jest.mock("@/lib/presence-sessions", () => ({ openSession: jest.fn().mockResolvedValue(undefined) }))

import { seatAtTheDoor } from "@/lib/check-in-core"
import { blockCounterparties } from "@/lib/conversations"
import { emitEventCheckIn } from "@/lib/socket-server"

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

beforeEach(() => jest.clearAllMocks())

it("answers without waiting for the arrival's broadcast", async () => {
  const result = await seat()

  expect(result.checkIn.id).toBe("ci1")
  expect(result.chatGroupId).toBe("room1")
  // Started, so the room still hears it — but not finished, and not awaited.
  expect(blockCounterparties).toHaveBeenCalledWith("u1")
  expect(emitEventCheckIn).not.toHaveBeenCalled()
})

it("announces nothing when the window only moved (a Go Live extended)", async () => {
  await seat(true)
  expect(blockCounterparties).not.toHaveBeenCalled()
})
