process.env.MOBILE_JWT_SECRET = "test-secret-at-least-32-characters-long!!"
process.env.NEXTAUTH_SECRET = "room-waves-test-secret-at-least-32-chars"

/*
 * `POST /events/:id/waves` — "I see you", with nothing stored.
 *
 * The rules: both inside now, not yourself, no block and no unmatched pair
 * (answered exactly like "not here", so a wave is not a way to learn who
 * blocked you), one per pair per ten minutes, and the sender named as the
 * recipient sees them in the room — pseudonym unless they revealed.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

const mockDb = {
  event_check_ins: { findFirst: jest.fn() },
  chat_group_members: { findFirst: jest.fn() },
  event_match_preferences: { findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))

const mockAuth = jest.fn()
jest.mock("@/lib/mobile-auth", () => ({ getAuthenticatedUser: (...a: unknown[]) => mockAuth(...a) }))
jest.mock("@/lib/rate-limit", () => ({
  rateLimit: jest.fn().mockResolvedValue(null),
  userLimit: jest.fn().mockReturnValue({ windowMs: 1, maxRequests: 99 }),
}))

const mockBlocked = jest.fn()
const mockClosed = jest.fn()
jest.mock("@/lib/conversations", () => ({
  blockedEitherWay: (...a: unknown[]) => mockBlocked(...a),
  pairIsClosed: (...a: unknown[]) => mockClosed(...a),
}))

const mockEmitWave = jest.fn()
jest.mock("@/lib/socket-server", () => ({ emitRoomWave: (...a: unknown[]) => mockEmitWave(...a) }))

import { NextRequest } from "next/server"
import { POST } from "@/app/api/mobile/events/[eventId]/waves/route"
import { resetMemoryStore } from "@/lib/rate-limit-store"
import { roomHandle } from "@/lib/room-handle"

const EVENT = "22222222-2222-2222-2222-222222222222"
const ME = "me"
const THEM = "them"

/** Somebody as this room's roster names them: their handle here (SCRUM-371). */
const inRoom = (userId: string, eventId: string = EVENT) => roomHandle(eventId, userId)

const wave = (toUserId: string = inRoom(THEM), eventId: string = EVENT) =>
  POST(
    new NextRequest(`https://api.blendn.app/api/mobile/events/${eventId}/waves`, {
      method: "POST",
      body: JSON.stringify({ toUserId }),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ eventId }) }
  )

/** Who is inside now, by user id. */
function inside(...ids: string[]) {
  mockDb.event_check_ins.findFirst.mockImplementation(async ({ where }: { where: { user_id: string } }) =>
    ids.includes(where.user_id) ? { id: `ci-${where.user_id}` } : null
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  resetMemoryStore()
  mockAuth.mockResolvedValue({ userId: ME, email: "me@b.com" })
  inside(ME, THEM)
  mockBlocked.mockResolvedValue(false)
  mockClosed.mockResolvedValue(false)
  mockDb.chat_group_members.findFirst.mockResolvedValue({ anonymous_name: "Cosmic Panda" })
  mockDb.event_match_preferences.findUnique.mockResolvedValue(null)
  mockDb.user.findUnique.mockResolvedValue({ name: "Arjun Rao" })
})

it("sends, and emits room:wave to the recipient with the sender's pseudonym", async () => {
  const res = await wave()
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ success: true, data: { sent: true } })
  // Real ids to the emitter, which is where the sender becomes a handle for
  // the recipient (see room-socket-payloads.test.ts) — so no caller can forget.
  expect(mockEmitWave).toHaveBeenCalledWith(THEM, { eventId: EVENT, fromUserId: ME, fromName: "Cosmic Panda" })
  // The real name is not even read for somebody who has not revealed.
  expect(mockDb.user.findUnique).not.toHaveBeenCalled()
})

it("uses the real name only for a sender who revealed in this room", async () => {
  mockDb.event_match_preferences.findUnique.mockResolvedValue({ revealed: true })
  await wave()
  expect(mockEmitWave).toHaveBeenCalledWith(THEM, expect.objectContaining({ fromName: "Arjun Rao" }))
})

it("requires both to be inside NOW, not merely to have attended", async () => {
  await wave()
  for (const [args] of mockDb.event_check_ins.findFirst.mock.calls) {
    expect(args.where).toMatchObject({ event_id: EVENT, status: "checked_in" })
  }
})

it("refuses a sender who is not checked in: 403 NOT_CHECKED_IN", async () => {
  inside(THEM)
  const res = await wave()
  expect(res.status).toBe(403)
  expect((await res.json()).errorCode).toBe("NOT_CHECKED_IN")
  expect(mockEmitWave).not.toHaveBeenCalled()
})

it("refuses a recipient who is not here: 403 RECIPIENT_NOT_HERE", async () => {
  inside(ME)
  const res = await wave()
  expect(res.status).toBe(403)
  expect((await res.json()).errorCode).toBe("RECIPIENT_NOT_HERE")
})

it("hides a recipient the roster hides: show_online off or suspended", async () => {
  await wave()
  const theirs = mockDb.event_check_ins.findFirst.mock.calls.find(([a]) => a.where.user_id === THEM)![0]
  expect(theirs.where.user).toEqual({
    suspended_at: null,
    OR: [{ profile: { is: null } }, { profile: { show_online: true } }],
  })
})

it.each([
  ["a block either way", () => mockBlocked.mockResolvedValue(true)],
  ["an unmatched pair", () => mockClosed.mockResolvedValue(true)],
])("answers %s exactly like 'not here'", async (_label, arrange) => {
  arrange()
  const res = await wave()
  expect(res.status).toBe(403)
  expect(await res.json()).toEqual({
    success: false,
    error: "They're not in the room right now",
    errorCode: "RECIPIENT_NOT_HERE",
  })
  expect(mockEmitWave).not.toHaveBeenCalled()
})

it("refuses waving at yourself: 400", async () => {
  const res = await wave(ME)
  expect(res.status).toBe(400)
  expect(mockEmitWave).not.toHaveBeenCalled()
})

it("allows one wave per pair per ten minutes: 429 WAVE_TOO_SOON", async () => {
  expect((await wave()).status).toBe(200)
  const res = await wave()
  expect(res.status).toBe(429)
  const body = await res.json()
  expect(body.errorCode).toBe("WAVE_TOO_SOON")
  expect(body.retryAfter).toBeGreaterThan(9 * 60)
  expect(mockEmitWave).toHaveBeenCalledTimes(1)
})

it("keeps the window per pair: waving at someone else is fine", async () => {
  inside(ME, THEM, "other")
  expect((await wave()).status).toBe(200)
  expect((await wave(inRoom("other"))).status).toBe(200)
})

it("does not start the clock on a wave that was refused", async () => {
  mockBlocked.mockResolvedValueOnce(true)
  expect((await wave()).status).toBe(403)
  expect((await wave()).status).toBe(200)
})

describe("room handles (SCRUM-371)", () => {
  const OTHER_EVENT = "33333333-3333-4333-8333-333333333333"
  const nobody = async () => {
    const res = await wave(inRoom("nobody-here"))
    return { status: res.status, body: await res.json() }
  }
  const answer = async (ref: string) => {
    const res = await wave(ref)
    return { status: res.status, body: await res.json() }
  }

  it("takes this room's handle and waves at the person behind it", async () => {
    expect((await wave(inRoom(THEM))).status).toBe(200)
    expect(mockEmitWave).toHaveBeenCalledWith(THEM, expect.objectContaining({ fromUserId: ME }))
  })

  it.each([
    ["a raw real id of somebody checked in and visible", () => THEM],
    ["their handle from another event", () => inRoom(THEM, OTHER_EVENT)],
    [
      "a forged handle",
      () => {
        const h = inRoom(THEM)
        return `${h.slice(0, -1)}${h.endsWith("A") ? "B" : "A"}`
      },
    ],
  ])("answers %s exactly as somebody who is not here", async (_label, ref) => {
    // `THEM` is inside and visible: only the ref differs from the 200 above.
    expect(await answer(ref())).toEqual(await nobody())
    expect(mockEmitWave).not.toHaveBeenCalled()
  })

  it("closes the too-soon finder: a raw-id wave is refused and starts no window", async () => {
    /*
     * The attack: wave at a friend's real id, then at each roster handle —
     * the one answered 429 is the friend. The raw-id wave is now nobody, so
     * it cannot start the pair's clock, and the handle's first wave goes.
     */
    expect((await wave(THEM)).status).toBe(403)
    expect((await wave(inRoom(THEM))).status).toBe(200)
  })

  it("keys the ten-minute window on the real pair, so a new room is not a new window", async () => {
    // The residual, recorded in SECURITY_BACKLOG: linking two rooms' handles
    // this way needs both people to move rooms within ten minutes.
    expect((await wave(inRoom(THEM), EVENT)).status).toBe(200)
    expect((await wave(inRoom(THEM, OTHER_EVENT), OTHER_EVENT)).status).toBe(429)
  })

  it("refuses your own id, and your own handle, as waving at yourself", async () => {
    expect((await wave(ME)).status).toBe(400)
    expect((await wave(inRoom(ME))).status).toBe(400)
  })
})
