process.env.MOBILE_JWT_SECRET = "test-secret-at-least-32-characters-long!!"

/*
 * The age rules where they are actually enforced.
 *
 * `age.test.ts` pins the rules; this pins that the routes call them. A gate on
 * one of two write paths is not a gate, and the per-event route is the more
 * likely bypass of the two — it is the path the check-in flow uses, and
 * `remember: true` writes the profile default straight through it.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

const mockDb = {
  profiles: { findUnique: jest.fn(), update: jest.fn(), upsert: jest.fn() },
  event_check_ins: { findFirst: jest.fn(), update: jest.fn() },
  user: { update: jest.fn(), findUnique: jest.fn() },
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

jest.mock("@/lib/location", () => ({
  normalizeLocationToCity: jest.fn().mockImplementation(async (l: string | null) => l),
}))

jest.mock("@/lib/conversations", () => ({ blockedEitherWay: jest.fn().mockResolvedValue(false) }))
jest.mock("@/lib/identity", () => ({ maySeeIdentity: jest.fn().mockResolvedValue(false) }))

import { NextRequest } from "next/server"
import { PUT as putProfile } from "@/app/api/mobile/profiles/[userId]/route"
import { PUT as putPrefs } from "@/app/api/mobile/events/[eventId]/matches/preferences/route"

const USER = "11111111-1111-1111-1111-111111111111"
const EVENT = "22222222-2222-2222-2222-222222222222"

const profileReq = (body: unknown) =>
  new NextRequest(`https://api.blendn.app/api/mobile/profiles/${USER}`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })

const prefsReq = (body: unknown) =>
  new NextRequest(`https://api.blendn.app/api/mobile/events/${EVENT}/matches/preferences`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })

beforeEach(() => {
  jest.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: USER, email: "a@b.com" })
  mockDb.profiles.upsert.mockResolvedValue({})
  mockDb.user.findUnique.mockResolvedValue({
    id: USER,
    email: "a@b.com",
    name: "A",
    image: null,
    profile: null,
    user_interests: [],
  })
  mockDb.event_check_ins.findFirst.mockResolvedValue({ id: "ci1" })
  mockDb.event_check_ins.update.mockResolvedValue({ intent: [], revealed: false })
})

describe("PUT /profiles/:userId — dating intent", () => {
  it("refuses a 17-year-old", async () => {
    mockDb.profiles.findUnique.mockResolvedValue({ age: 17, intent_default: [] })
    const res = await putProfile(profileReq({ intent_default: ["dating"] }), {
      params: Promise.resolve({ userId: USER }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/18\+/)
    expect(mockDb.profiles.upsert).not.toHaveBeenCalled()
  })

  it("refuses when we have no age at all", async () => {
    mockDb.profiles.findUnique.mockResolvedValue({ age: null, intent_default: [] })
    const res = await putProfile(profileReq({ intent_default: ["dating"] }), {
      params: Promise.resolve({ userId: USER }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/add your age/i)
  })

  it("allows an adult", async () => {
    mockDb.profiles.findUnique.mockResolvedValue({ age: 30, intent_default: [] })
    const res = await putProfile(profileReq({ intent_default: ["dating", "networking"] }), {
      params: Promise.resolve({ userId: USER }),
    })
    expect(res.status).toBe(200)
  })

  it("accepts an age and a dating intent in the same request", async () => {
    /*
     * The about-you screen sends both at once. Judging the request against the
     * age already on file would refuse a null the user is in the act of
     * filling in — a gate that only ever fires on the first save.
     */
    mockDb.profiles.findUnique.mockResolvedValue({ age: null, intent_default: [] })
    const res = await putProfile(profileReq({ age: 24, intent_default: ["dating"] }), {
      params: Promise.resolve({ userId: USER }),
    })
    expect(res.status).toBe(200)
  })

  it("does not gate a request that never mentions dating", async () => {
    mockDb.profiles.findUnique.mockResolvedValue({ age: 15, intent_default: [] })
    const res = await putProfile(profileReq({ intent_default: ["friendship"] }), {
      params: Promise.resolve({ userId: USER }),
    })
    expect(res.status).toBe(200)
  })

  it("strips dating when the age is lowered past the line", async () => {
    /*
     * The two-request bypass: set 25, tick dating, then set 15. Both requests
     * are individually legal and the result is a 15-year-old in the dating
     * pool. Stripped rather than refused — the correction is more likely to be
     * the truth, and refusing it is the wrong incentive.
     */
    mockDb.profiles.findUnique.mockResolvedValue({ age: 25, intent_default: ["dating", "friendship"] })
    const res = await putProfile(profileReq({ age: 15 }), {
      params: Promise.resolve({ userId: USER }),
    })
    expect(res.status).toBe(200)
    expect(mockDb.profiles.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ age: 15, intent_default: ["friendship"] }),
      })
    )
  })

  it("leaves the intents alone when the new age still qualifies", async () => {
    mockDb.profiles.findUnique.mockResolvedValue({ age: 25, intent_default: ["dating"] })
    await putProfile(profileReq({ age: 26 }), { params: Promise.resolve({ userId: USER }) })
    const update = mockDb.profiles.upsert.mock.calls[0][0].update
    expect(update).not.toHaveProperty("intent_default")
  })
})

describe("PUT /events/:eventId/matches/preferences — dating intent", () => {
  it("refuses a 17-year-old from inside a room", async () => {
    // The bypass this closes: the profile gate alone could be walked around by
    // setting the same value here, which also writes the default via `remember`.
    mockDb.profiles.findUnique.mockResolvedValue({ age: 17 })
    const res = await putPrefs(prefsReq({ intent: ["dating"], remember: true }), {
      params: Promise.resolve({ eventId: EVENT }),
    })
    expect(res.status).toBe(403)
    expect(mockDb.event_check_ins.update).not.toHaveBeenCalled()
    expect(mockDb.profiles.update).not.toHaveBeenCalled()
  })

  it("allows an adult", async () => {
    mockDb.profiles.findUnique.mockResolvedValue({ age: 22 })
    const res = await putPrefs(prefsReq({ intent: ["dating"] }), {
      params: Promise.resolve({ eventId: EVENT }),
    })
    expect(res.status).toBe(200)
    expect(mockDb.event_check_ins.update).toHaveBeenCalled()
  })

  it("does not read the profile when intent is not being set", async () => {
    // Reveal-only saves are the common case from the room screen; they should
    // not pay for a lookup the rule does not need.
    await putPrefs(prefsReq({ revealed: true }), { params: Promise.resolve({ eventId: EVENT }) })
    expect(mockDb.profiles.findUnique).not.toHaveBeenCalled()
  })

  it("still requires a check-in before anything else", async () => {
    mockDb.event_check_ins.findFirst.mockResolvedValue(null)
    const res = await putPrefs(prefsReq({ intent: ["dating"] }), {
      params: Promise.resolve({ eventId: EVENT }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/check in/i)
  })
})
