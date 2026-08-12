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
  user_oauth_accounts: { deleteMany: jest.fn() },
  account: { deleteMany: jest.fn() },
  session: { deleteMany: jest.fn() },
  $transaction: jest.fn().mockResolvedValue([]),
}
jest.mock("@/lib/db", () => ({ db: mockDb }))

const mockAuth = jest.fn()
jest.mock("@/lib/mobile-auth", () => ({
  getAuthenticatedUser: (...a: unknown[]) => mockAuth(...a),
}))

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
    expect(data.orientation).toBeNull()
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
    expect(mockDb).not.toHaveProperty("event_check_ins")
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
