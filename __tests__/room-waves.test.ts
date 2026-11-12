process.env.MOBILE_JWT_SECRET = "test-secret-at-least-32-characters-long!!"
process.env.NEXTAUTH_SECRET = "room-waves-test-secret-at-least-32-chars"

/*
 * `POST /events/:id/waves` — "I see you", recorded (SCRUM-1042).
 *
 * The route's order and answers: the sender first (in the room, not staff, not
 * a host, the room open), then the sender's stored caps (W3-W6) BEFORE
 * anything about the recipient (W8), then the recipient (not here, blocked,
 * banned, unmatched, a friend, a host: one answer), one wave per pair per room
 * (W1), the 10-minute live-ping window across rooms (W2), and a mutual through
 * the like-match path. `lib/waves.ts` is mocked here with an in-memory store;
 * the stored caps and the real tables are `integration/recorded-waves.itest.ts`.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

const mockDb = {
  // The room's host side (`roomIdentity`, SCRUM-887): nobody here hosts.
  organisation_members: { findMany: jest.fn(async () => []) },
  event_check_ins: { findFirst: jest.fn(), findMany: jest.fn() },
  chat_group_members: { findFirst: jest.fn() },
  event_match_preferences: { findMany: jest.fn() },
  user: { findUnique: jest.fn() },
  // The rest of the room identity rule (`visibleInRoom`): blocks, closed pairs
  // and friends. Empty unless a case sets them.
  blocked_users: { findMany: jest.fn() },
  private_conversations: { findMany: jest.fn() },
  friendships: { findMany: jest.fn(), findFirst: jest.fn(async () => null) },
  ended_friendships: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
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

/** Stored waves, `event|from|to`; the cap the sender is at (null: under every cap); the room open or closed. */
const waves = new Set<string>()
const mockCap = jest.fn()
const mockRoomOpen = jest.fn()
jest.mock("@/lib/waves", () => ({
  hasWaved: async (e: string, f: string, t: string) => waves.has(`${e}|${f}|${t}`),
  // The viewer's list rule is the integration suite's; here a stored wave is a visible one.
  hasVisibleWaveFrom: async (viewer: string, e: string, from: string) => waves.has(`${e}|${from}|${viewer}`),
  recordWave: async (e: string, f: string, t: string) => {
    const k = `${e}|${f}|${t}`
    if (waves.has(k)) return { recorded: false, capped: null }
    waves.add(k)
    return { recorded: true }
  },
  waveCapFor: (...a: unknown[]) => mockCap(...a),
  roomIsOpen: (...a: unknown[]) => mockRoomOpen(...a),
  receivedWaves: jest.fn(),
}))
const mockOpenIfMutual = jest.fn()
jest.mock("@/lib/matches", () => ({ openIfMutual: (...a: unknown[]) => mockOpenIfMutual(...a) }))
const mockAnnounce = jest.fn()
jest.mock("@/lib/room-match", () => ({ announceRoomMatch: (...a: unknown[]) => mockAnnounce(...a) }))
/** Who runs or hosts the event. */
const hosts = new Set<string>()
jest.mock("@/lib/tonight", () => ({ operatesEvent: async (userId: string) => hosts.has(userId) }))

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

/**
 * Who is inside now, by user id; `attended` were checked in here earlier and
 * have left. A lookup that asks for `status: "checked_in"` is presence; one
 * that does not is attendance.
 */
function inside(...ids: string[]) {
  return attendance(ids, [])
}
function attendance(now: string[], left: string[]) {
  const ids = [...now, ...left]
  mockDb.event_check_ins.findFirst.mockImplementation(async ({ where }: { where: { user_id: string; status?: string } }) => {
    const present = where.status === "checked_in" ? now.includes(where.user_id) : ids.includes(where.user_id)
    return present ? { id: `ci-${where.user_id}`, kind: "attendee" } : null
  })
  // `visibleInRoom` asks whether the recipient was in the room at all.
  mockDb.event_check_ins.findMany.mockImplementation(async ({ where }: { where: { user_id: { in: string[] } } }) =>
    where.user_id.in.filter((id) => ids.includes(id)).map((user_id) => ({ user_id }))
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  resetMemoryStore()
  waves.clear()
  hosts.clear()
  mockCap.mockResolvedValue(null)
  mockRoomOpen.mockResolvedValue(true)
  mockOpenIfMutual.mockResolvedValue({ mutual: false })
  mockAnnounce.mockResolvedValue(undefined)
  mockAuth.mockResolvedValue({ userId: ME, email: "me@b.com" })
  inside(ME, THEM)
  mockBlocked.mockResolvedValue(false)
  mockClosed.mockResolvedValue(false)
  // The sender's pseudonym; and `eventRoomBan` (a `status: "banned"` read) finds no ban.
  mockDb.chat_group_members.findFirst.mockImplementation(async (args: { where?: { status?: string } }) =>
    args?.where?.status === "banned" ? null : { anonymous_name: "Cosmic Panda" }
  )
  mockDb.event_match_preferences.findMany.mockResolvedValue([])
  mockDb.user.findUnique.mockResolvedValue({ name: "Arjun Rao" })
  mockDb.blocked_users.findMany.mockResolvedValue([])
  mockDb.private_conversations.findMany.mockResolvedValue([])
  mockDb.friendships.findMany.mockResolvedValue([])
  mockDb.friendships.findFirst.mockResolvedValue(null)
})

it("sends, and emits room:wave to the recipient with the sender’s pseudonym", async () => {
  const res = await wave()
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ success: true, data: { sent: true, mutual: false } })
  expect(waves.has(`${EVENT}|${ME}|${THEM}`)).toBe(true)
  // Real ids to the emitter, which is where the sender becomes a handle for
  // the recipient (see room-socket-payloads.test.ts) — so no caller can forget.
  expect(mockEmitWave).toHaveBeenCalledWith(THEM, { eventId: EVENT, fromUserId: ME, fromName: "Cosmic Panda" })
  // The real name is not even read for somebody who has not revealed.
  expect(mockDb.user.findUnique).not.toHaveBeenCalled()
})

it("uses the real name only for a sender who revealed in this room", async () => {
  // The roster's rule (`visibleInRoom`): revealed at THIS event.
  mockDb.event_match_preferences.findMany.mockResolvedValue([{ user_id: ME }])
  await wave()
  expect(mockDb.event_match_preferences.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ event_id: EVENT, revealed: true }) })
  )
  expect(mockEmitWave).toHaveBeenCalledWith(THEM, expect.objectContaining({ fromName: "Arjun" }))
})

it("requires both to be inside NOW for a new wave, not merely to have attended", async () => {
  attendance([THEM], [ME])
  expect((await wave()).status).toBe(403)
  attendance([ME], [THEM])
  const res = await wave()
  expect(res.status).toBe(403)
  expect((await res.json()).errorCode).toBe("RECIPIENT_NOT_HERE")
  // Control: both inside, the same wave goes.
  inside(ME, THEM)
  expect((await wave()).status).toBe(200)
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
  expect(theirs.where.kind).toBe("attendee")
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
    error: "They’re not in the room right now",
    errorCode: "RECIPIENT_NOT_HERE",
  })
  expect(mockEmitWave).not.toHaveBeenCalled()
})

it("refuses waving at yourself: 400", async () => {
  const res = await wave(ME)
  expect(res.status).toBe(400)
  expect(mockEmitWave).not.toHaveBeenCalled()
})

it("W1: one wave per pair per room, never again: a second tap is the first answer, with no ping", async () => {
  const first = await (await wave()).json()
  const again = await wave()
  expect(again.status).toBe(200)
  expect(await again.json()).toEqual(first)
  expect(mockEmitWave).toHaveBeenCalledTimes(1)
  expect(mockOpenIfMutual).toHaveBeenCalledTimes(1)
  expect(waves.size).toBe(1)
})

it("W2: a new wave at the same person in another room within ten minutes is 429 WAVE_TOO_SOON", async () => {
  const OTHER = "44444444-4444-4444-8444-444444444444"
  expect((await wave(inRoom(THEM), EVENT)).status).toBe(200)
  const res = await wave(inRoom(THEM, OTHER), OTHER)
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

  it("takes this room’s handle and waves at the person behind it", async () => {
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

describe("W8: a capped sender learns nothing about the person they waved at", () => {
  const capped = { cap: "room_hour", retryAfter: 1200 }
  const send = async (ref: string) => {
    const res = await wave(ref)
    return { status: res.status, retryAfter: res.headers.get("Retry-After"), body: await res.json() }
  }
  /** Did anything read the recipient's check-in, block, ban or friendship? */
  const recipientRead = () =>
    mockDb.event_check_ins.findFirst.mock.calls.some(([a]) => a.where.user_id === THEM) ||
    mockBlocked.mock.calls.length > 0 ||
    mockClosed.mock.calls.length > 0

  beforeEach(() => mockCap.mockResolvedValue(capped))

  it("is the same 429 whether they are here, blocking you, or nobody, and reads none of it", async () => {
    const present = await send(inRoom(THEM))
    expect(present.status).toBe(429)
    expect(present.body).toEqual({
      success: false,
      error: "You’ve waved a lot in this room. Try again in a bit.",
      errorCode: "RATE_LIMITED",
      retryAfter: 1200,
    })
    expect(present.retryAfter).toBe("1200")
    expect(recipientRead()).toBe(false)

    mockBlocked.mockResolvedValue(true)
    expect(await send(inRoom(THEM))).toEqual(present)
    inside(ME)
    expect(await send(inRoom(THEM))).toEqual(present)
    expect(await send(inRoom("nobody-here"))).toEqual(present)
    expect(recipientRead()).toBe(false)
    expect(waves.size).toBe(0)
    expect(mockEmitWave).not.toHaveBeenCalled()
  })

  it("the daily cap says 'today', also about the sender only", async () => {
    mockCap.mockResolvedValue({ cap: "day", retryAfter: 3600 })
    const res = await send(inRoom(THEM))
    expect(res.body.error).toBe("You’ve waved a lot today. Try again later.")
    expect(res.body.errorCode).toBe("RATE_LIMITED")
  })

  it("asks the cap about the sender and this room only", async () => {
    await send(inRoom(THEM))
    expect(mockCap).toHaveBeenCalledWith(ME, EVENT)
  })

  it("control: under the caps, the recipient is read and the wave goes", async () => {
    mockCap.mockResolvedValue(null)
    expect((await send(inRoom(THEM))).status).toBe(200)
    expect(recipientRead()).toBe(true)
  })
})

describe("a wave back may be sent until the room closes, even if either has left (approval 10)", () => {
  beforeEach(() => waves.add(`${EVENT}|${THEM}|${ME}`))

  it("you left: you can still wave back at somebody who waved at you", async () => {
    attendance([THEM], [ME])
    expect((await wave()).status).toBe(200)
    expect(waves.has(`${EVENT}|${ME}|${THEM}`)).toBe(true)
  })

  it("they left: you can still wave back, and their attendance is what is asked", async () => {
    attendance([ME], [THEM])
    expect((await wave()).status).toBe(200)
    const theirs = mockDb.event_check_ins.findFirst.mock.calls.find(([a]) => a.where.user_id === THEM)![0]
    expect(theirs.where.status).toBeUndefined()
    expect(theirs.where.check_in_time).toEqual({ not: null })
  })

  it("both left: still answerable", async () => {
    attendance([], [ME, THEM])
    expect((await wave()).status).toBe(200)
  })

  it("is never held by the ten-minute window from another room", async () => {
    const OTHER = "55555555-5555-4555-8555-555555555555"
    waves.add(`${OTHER}|${THEM}|${ME}`)
    expect((await wave(inRoom(THEM), EVENT)).status).toBe(200)
    expect((await wave(inRoom(THEM, OTHER), OTHER)).status).toBe(200)
  })

  it("not once the room has closed", async () => {
    attendance([], [ME, THEM])
    mockRoomOpen.mockResolvedValue(false)
    const res = await wave()
    expect(res.status).toBe(403)
    expect((await res.json()).errorCode).toBe("NOT_CHECKED_IN")
  })

  it("control: with no wave to answer, leaving means you cannot wave", async () => {
    waves.clear()
    attendance([THEM], [ME])
    const res = await wave()
    expect(res.status).toBe(403)
    expect((await res.json()).errorCode).toBe("NOT_CHECKED_IN")
  })

  it("a block still beats it, answered to a sender who left exactly as 'no wave to answer'", async () => {
    attendance([], [ME, THEM])
    mockBlocked.mockResolvedValue(true)
    const blocked = await wave()
    waves.clear()
    mockBlocked.mockResolvedValue(false)
    const nothingToAnswer = await wave()
    expect(blocked.status).toBe(403)
    expect(await blocked.json()).toEqual(await nothingToAnswer.json())
  })
})

describe("a mutual opens the conversation through the like-match path", () => {
  const mutual = { mutual: true, conversationId: "conv-1", pseudonyms: { you: "Cosmic Panda", them: "Quiet Heron" } }

  it("answers the moment, announces room:match to both, and sends no room:wave", async () => {
    mockOpenIfMutual.mockResolvedValue(mutual)
    const res = await wave()
    expect(await res.json()).toEqual({ success: true, data: { sent: true, ...mutual } })
    expect(mockOpenIfMutual).toHaveBeenCalledWith(EVENT, ME, THEM)
    expect(mockAnnounce).toHaveBeenCalledWith(EVENT, "conv-1")
    expect(mockEmitWave).not.toHaveBeenCalled()
  })

  it("control: a one-way wave pings and announces nothing", async () => {
    await wave()
    expect(mockAnnounce).not.toHaveBeenCalled()
    expect(mockEmitWave).toHaveBeenCalledTimes(1)
  })
})

describe("hosts never wave and are never waved at", () => {
  it("a host is answered as somebody not checked in, and nothing is read about the recipient", async () => {
    hosts.add(ME)
    const res = await wave()
    expect((await res.json()).errorCode).toBe("NOT_CHECKED_IN")
    expect(mockCap).not.toHaveBeenCalled()
  })

  it("a host is not here to wave at", async () => {
    hosts.add(THEM)
    const res = await wave()
    expect((await res.json()).errorCode).toBe("RECIPIENT_NOT_HERE")
    expect(waves.size).toBe(0)
  })

  it("staff (your latest row) cannot wave", async () => {
    mockDb.event_check_ins.findFirst.mockImplementation(async ({ where }: { where: { user_id: string } }) =>
      where.user_id === ME ? { id: "ci", kind: "staff" } : { id: "ci", kind: "attendee" }
    )
    expect((await (await wave()).json()).errorCode).toBe("NOT_CHECKED_IN")
  })
})
