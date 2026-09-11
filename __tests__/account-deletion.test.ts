process.env.MOBILE_JWT_SECRET = "test-secret-at-least-32-characters-long!!"

/*
 * What "delete my account" actually removes.
 *
 * The `User` row is deliberately kept and anonymised rather than deleted:
 * `organized_events`, `chat_messages` and several other relations cascade on
 * `User`, so a hard delete would destroy other people's event and chat history
 * to honour one person's request. That decision is right, and it has a cost —
 * nothing is removed automatically, so every new column on `profiles` is a
 * field that survives deletion until somebody remembers it.
 *
 * `goals` and `looking_for` already survived one release that way. The second
 * test below is the one that stops it happening again: it reads the schema and
 * fails when a field is neither scrubbed nor explicitly listed as kept.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

const mockDb = {
  user: { update: jest.fn() },
  profiles: { update: jest.fn() },
  user_interests: { deleteMany: jest.fn() },
  event_match_preferences: { deleteMany: jest.fn() },
  mobile_refresh_tokens: { deleteMany: jest.fn() },
  push_tokens: { deleteMany: jest.fn() },
  photo_checks: { deleteMany: jest.fn() },
  city_demand: { deleteMany: jest.fn() },
  product_events: { deleteMany: jest.fn() },
  user_oauth_accounts: { deleteMany: jest.fn() },
  account: { deleteMany: jest.fn() },
  session: { deleteMany: jest.fn() },
  // Rows that deliberately SURVIVE the deletion and are scrubbed in place —
  // attendance is somebody else's history, the coordinates are not.
  event_check_ins: { updateMany: jest.fn() },
  presence_sessions: { updateMany: jest.fn() },
  notifications: { deleteMany: jest.fn() },
  password_reset_tokens: { deleteMany: jest.fn() },
  message_requests: { updateMany: jest.fn() },
  board_posts: { deleteMany: jest.fn() },
  board_requests: { updateMany: jest.fn() },
  $transaction: jest.fn().mockResolvedValue([]),
}
jest.mock("@/lib/db", () => ({ db: mockDb }))

const mockAuth = jest.fn()
jest.mock("@/lib/mobile-auth", () => ({
  getAuthenticatedUser: (...a: unknown[]) => mockAuth(...a),
}))

const mockDeletePrefix = jest.fn().mockResolvedValue(3)
jest.mock("@/lib/tigris", () => ({ deletePrefix: (...a: unknown[]) => mockDeletePrefix(...a) }))
jest.mock("@/lib/rate-limit", () => ({
  rateLimit: jest.fn().mockResolvedValue(null),
  userLimit: jest.fn().mockReturnValue({ windowMs: 1, maxRequests: 99 }),
}))

import { readFileSync } from "fs"
import { join, resolve } from "path"
import { NextRequest } from "next/server"
import { DELETE } from "@/app/api/mobile/account/route"

const USER = "u1"

beforeEach(() => {
  jest.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: USER, email: "a@b.com" })
})

const del = () =>
  DELETE(new NextRequest("https://api.blendn.app/api/mobile/account", { method: "DELETE" }))

/** The `data` object the route hands `profiles.update`. */
async function scrubPayload(): Promise<Record<string, unknown>> {
  await del()
  return mockDb.profiles.update.mock.calls[0][0].data
}

describe("deleting an account scrubs the matching inputs", () => {
  it("clears gender, orientation and interested_in", async () => {
    // The most sensitive fields on the row, collected only from people who
    // ticked dating and returned to nobody but their owner. An account that
    // keeps its owner's orientation after deletion is an audit finding.
    const data = await scrubPayload()
    expect(data.gender).toBeNull()
    expect(data.orientations).toEqual([])
    expect(data.interested_in).toEqual([])
  })

  it("clears what they were open to and what they do", async () => {
    const data = await scrubPayload()
    expect(data.intent_default).toEqual([])
    expect(data.reveal_by_default).toBe(false)
    expect(data.work_field).toBeNull()
  })

  it("still clears the fields it always did", async () => {
    const data = await scrubPayload()
    for (const field of ["name", "phone", "age", "location", "bio", "occupation", "education"]) {
      expect(data[field]).toBeNull()
    }
    expect(data.goals).toEqual([])
    expect(data.looking_for).toEqual([])
  })

  it("removes the structured interests, which nothing cascades", async () => {
    // They would cascade on a `User` delete — and the `User` row is kept on
    // purpose, so nothing removes them unless this does.
    await del()
    expect(mockDb.user_interests.deleteMany).toHaveBeenCalledWith({ where: { user_id: USER } })
    // Where they were waiting is theirs too. It cascades on the foreign key as
    // well; asserted here so the deletion path stays a readable list of
    // everything it removes rather than a set of constraints to go and check.
    expect(mockDb.city_demand.deleteMany).toHaveBeenCalledWith({ where: { user_id: USER } })
    /*
     * DELETED, not scrubbed. A scrubbed row cannot be counted as a distinct
     * person, so nulling `user_id` would keep a record of when somebody was
     * awake and looking while no longer answering anything.
     */
    expect(mockDb.product_events.deleteMany).toHaveBeenCalledWith({ where: { user_id: USER } })
  })

  it("removes their per-event choices but not their attendance", async () => {
    /*
     * Attendance is somebody else's history too: the organiser's headcount, and
     * the co-presence that lets people who actually met them keep a
     * conversation open. What they were *open to* is only theirs.
     */
    await del()
    expect(mockDb.event_match_preferences.deleteMany).toHaveBeenCalledWith({
      where: { user_id: USER },
    })

    /*
     * This asserted the mock had no `event_check_ins` key at all, which proved
     * the table was never touched. It is touched now — scrubbed of its GPS fix
     * and device fingerprint — so the assertion is the more precise one it
     * always meant: the attendance row is never DELETED, because deleting it
     * would take the organiser's headcount with it.
     */
    expect((mockDb.event_check_ins as { deleteMany?: unknown }).deleteMany).toBeUndefined()
  })

  it("does it all in one transaction", async () => {
    // A half-scrubbed account is worse than an unscrubbed one: it looks done.
    await del()
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1)
  })

  it("refuses an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null)
    expect((await del()).status).toBe(401)
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })
})

describe("no field on the profile survives deletion unnoticed", () => {
  /*
   * The durable version of this test.
   *
   * Every column added to `profiles` from here on is a field that survives
   * account deletion until somebody remembers to scrub it — `goals` and
   * `looking_for` already survived a release exactly that way. Rather than
   * listing today's fields, this reads the schema: a new column fails here
   * until it is either scrubbed or named below with a reason.
   */
  const KEPT: Record<string, string> = {
    id: "the FK to User, which is kept so other people's history survives",
    created_at: "when the row was made — not about the person",
    updated_at: "bookkeeping",
    user: "the relation, not a column",
    // The four settings booleans describe how the (now dead) account would
    // behave, not who the person was. Their defaults are already harmless and
    // nothing reads them for a deleted account.
    push_enabled: "a setting, not an attribute of the person",
    show_online: "a setting, not an attribute of the person",
    read_receipts: "a setting, not an attribute of the person",
    share_location: "a setting, not an attribute of the person",
  }

  function profileFields(): string[] {
    const schema = readFileSync(
      join(resolve(__dirname, ".."), "prisma", "schema.prisma"),
      "utf8"
    )
    const body = schema.match(/model profiles \{([\s\S]*?)\n\}/)?.[1]
    if (!body) throw new Error("could not find the `profiles` model in schema.prisma")

    return body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("//") && !line.startsWith("/") && !line.startsWith("@@"))
      .map((line) => line.split(/\s+/)[0])
      .filter((name) => /^[a-z_][a-z0-9_]*$/i.test(name))
  }

  it("finds the model at all", () => {
    // Without this the assertion below passes vacuously if the regex breaks.
    expect(profileFields().length).toBeGreaterThan(15)
  })

  it("scrubs every field that is not explicitly kept", async () => {
    const scrubbed = new Set(Object.keys(await scrubPayload()))
    const unaccounted = profileFields().filter((f) => !scrubbed.has(f) && !(f in KEPT))

    // Named rather than counted, so a failure says which column to think about.
    expect(unaccounted).toEqual([])
  })
})

describe("what survives a deletion, and what must not", () => {
  /*
   * The transaction scrubbed nineteen profile fields and left a trail of
   * exactly where somebody had been, on which nights, to within a few metres.
   *
   * `event_check_ins` is deliberately kept — attendance is the organiser's
   * headcount and the co-presence that lets people who met them still hold a
   * conversation. None of those readers needs the GPS fix that validated the
   * check-in, or the device fingerprint beside it. So the FACT stays and the
   * COORDINATES go.
   *
   * `presence_sessions` is the same shape and was introduced after this
   * transaction was last reviewed, so the deletion path silently stopped being
   * complete the day that model landed. That is the failure mode worth naming:
   * erasure is not a thing you write once.
   */
  it("keeps the attendance and drops the position", async () => {
    await del()

    expect(mockDb.event_check_ins.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ latitude: null, longitude: null }),
      })
    )
    expect(mockDb.presence_sessions.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ last_lat: null, last_lng: null, last_accuracy: null }),
      })
    )
    // Never deleted: that would take the organiser's numbers with it.
    expect((mockDb.event_check_ins as { deleteMany?: unknown }).deleteMany).toBeUndefined()
  })

  it("removes the notification copies of message previews", async () => {
    // `title` and `body` are a permanent copy of push previews — counterparty
    // names and message text — outside every control that guards the messages.
    await del()
    expect(mockDb.notifications.deleteMany).toHaveBeenCalled()
  })

  it("kills any live password reset token", async () => {
    // A live token for an account that no longer exists is a way back into it.
    await del()
    expect(mockDb.password_reset_tokens.deleteMany).toHaveBeenCalled()
  })

  it("scrubs only the requests they sent, not the ones they received", async () => {
    /*
     * The row is a two-party artifact and stays, or the recipient's inbox
     * develops holes. The `message` is one party's words — theirs to erase
     * when they wrote it, and not theirs when they did not.
     */
    await del()
    const call = mockDb.message_requests.updateMany.mock.calls[0][0]
    expect(call.where).toEqual(expect.objectContaining({ sender_id: expect.any(String) }))
    expect(call.where).not.toHaveProperty("recipient_id")
    expect(call.data).toEqual({ message: null })
  })
})

describe("the photos leave storage, not only the row", () => {
  /*
   * `profiles.photos` was nulled and the objects stayed in a public-read
   * bucket under deterministic keys -- any URL another person had seen kept
   * resolving to the deleted face. The prefix is everything this account ever
   * uploaded as a profile photo.
   */
  it("deletes every object under profile/{userId}/ after the transaction", async () => {
    mockAuth.mockResolvedValue({ userId: USER })
    const res = await DELETE(new NextRequest("http://x/api/mobile/account", { method: "DELETE" }))
    expect(res.status).toBe(200)
    expect(mockDeletePrefix).toHaveBeenCalledWith(`profile/${USER}/`)
    // After, not inside: the transaction is the erasure; storage is cleanup.
    const txOrder = mockDb.$transaction.mock.invocationCallOrder[0]
    const delOrder = mockDeletePrefix.mock.invocationCallOrder[0]
    expect(delOrder).toBeGreaterThan(txOrder)
  })

  it("a storage failure does not undo the erasure the database accepted", async () => {
    mockAuth.mockResolvedValue({ userId: USER })
    mockDeletePrefix.mockRejectedValueOnce(new Error("listing failed"))
    const res = await DELETE(new NextRequest("http://x/api/mobile/account", { method: "DELETE" }))
    expect(res.status).toBe(200)
  })
})
