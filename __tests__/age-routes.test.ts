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
  event_match_preferences: { upsert: jest.fn() },
  // Revealing in the room carries into DMs opened from it.
  private_conversations: { updateMany: jest.fn() },
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
const maySeeIdentity = jest.fn().mockResolvedValue(false)
jest.mock("@/lib/identity", () => ({ maySeeIdentity: (...a: unknown[]) => maySeeIdentity(...a) }))

import { NextRequest } from "next/server"
import { GET as getProfile, PUT as putProfile } from "@/app/api/mobile/profiles/[userId]/route"
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
  mockDb.event_match_preferences.upsert.mockResolvedValue({ intent: [], revealed: false })
  mockDb.private_conversations.updateMany.mockResolvedValue({ count: 0 })
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
    expect(mockDb.event_match_preferences.upsert).not.toHaveBeenCalled()
    expect(mockDb.profiles.update).not.toHaveBeenCalled()
  })

  it("allows an adult", async () => {
    mockDb.profiles.findUnique.mockResolvedValue({ age: 22 })
    const res = await putPrefs(prefsReq({ intent: ["dating"] }), {
      params: Promise.resolve({ eventId: EVENT }),
    })
    expect(res.status).toBe(200)
    // Keyed on (event_id, user_id), not on whichever check-in row came back:
    // a five-day event gives one person five of those and one answer.
    expect(mockDb.event_match_preferences.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { event_id_user_id: { event_id: EVENT, user_id: USER } },
      })
    )
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

describe("PUT /profiles/:userId — orientation and interested_in", () => {
  it("derives interested_in from gender and orientation", async () => {
    mockDb.profiles.findUnique.mockResolvedValue({
      age: 30,
      intent_default: [],
      gender: null,
      orientation: null,
    })
    await putProfile(profileReq({ gender: "woman", orientation: "straight" }), {
      params: Promise.resolve({ userId: USER }),
    })
    expect(mockDb.profiles.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ orientation: "straight", interested_in: ["man"] }),
      })
    )
  })

  it("lets a client-supplied interested_in win over derivation", async () => {
    /*
     * The precedence that keeps a hand-picked preference from being replaced.
     * Two writers to one column with no ordering is exactly how someone's
     * explicit list becomes a derived empty set on the next save.
     */
    mockDb.profiles.findUnique.mockResolvedValue({
      age: 30,
      intent_default: [],
      gender: null,
      orientation: null,
    })
    await putProfile(
      profileReq({ gender: "woman", orientation: "straight", interested_in: ["woman", "man"] }),
      { params: Promise.resolve({ userId: USER }) }
    )
    const update = mockDb.profiles.upsert.mock.calls[0][0].update
    expect(update.interested_in).toEqual(["woman", "man"])
  })

  it("leaves interested_in alone when the pair implies nothing", async () => {
    // "Straight" plus "non-binary" has no defined target set, so the column is
    // untouched and the app asks directly — null must not mean "clear it".
    mockDb.profiles.findUnique.mockResolvedValue({
      age: 30,
      intent_default: [],
      gender: null,
      orientation: null,
    })
    await putProfile(profileReq({ gender: "non_binary", orientation: "straight" }), {
      params: Promise.resolve({ userId: USER }),
    })
    const update = mockDb.profiles.upsert.mock.calls[0][0].update
    expect(update).not.toHaveProperty("interested_in")
    expect(update.orientation).toBe("straight")
  })

  it("re-derives against the stored half when only one is sent", async () => {
    // Saving gender first and orientation second is a legal two-step, and it
    // has to end up in the same place as sending both at once.
    mockDb.profiles.findUnique.mockResolvedValue({
      age: 30,
      intent_default: [],
      gender: "man",
      orientation: null,
    })
    await putProfile(profileReq({ orientation: "gay" }), {
      params: Promise.resolve({ userId: USER }),
    })
    const update = mockDb.profiles.upsert.mock.calls[0][0].update
    expect(update.interested_in).toEqual(["man"])
  })

  it("refuses an orientation that is not on the list", async () => {
    const res = await putProfile(profileReq({ orientation: "heterosexual" }), {
      params: Promise.resolve({ userId: USER }),
    })
    expect(res.status).toBe(400)
  })
})

describe("PUT /events/:eventId/matches/preferences — remember means one thing at a time", () => {
  beforeEach(() => {
    mockDb.profiles.findUnique.mockResolvedValue({ age: 30 })
  })

  it("rememberReveal writes the reveal default and NOT the intent default", async () => {
    /*
     * The bug this splits. `remember` set both, and the app renders that switch
     * under the reveal toggle labelled "Do this at future events too" — so
     * agreeing to be named at future work meetups silently overwrote a
     * person-level intent set on a different screen for a different reason.
     */
    await putPrefs(prefsReq({ intent: ["networking"], revealed: true, rememberReveal: true }), {
      params: Promise.resolve({ eventId: EVENT }),
    })
    expect(mockDb.profiles.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { reveal_by_default: true } })
    )
  })

  it("rememberIntent writes the intent default and NOT the reveal default", async () => {
    await putPrefs(prefsReq({ intent: ["networking"], revealed: true, rememberIntent: true }), {
      params: Promise.resolve({ eventId: EVENT }),
    })
    expect(mockDb.profiles.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { intent_default: ["networking"] } })
    )
  })

  it("still honours the deprecated `remember` as both", async () => {
    // The shipped build sends this, and an app in the store is a client you
    // cannot upgrade. Removing it the day the split lands would break them.
    await putPrefs(prefsReq({ intent: ["dating"], revealed: true, remember: true }), {
      params: Promise.resolve({ eventId: EVENT }),
    })
    expect(mockDb.profiles.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { intent_default: ["dating"], reveal_by_default: true },
      })
    )
  })

  it("writes no profile default when neither flag is sent", async () => {
    await putPrefs(prefsReq({ intent: ["networking"], revealed: true }), {
      params: Promise.resolve({ eventId: EVENT }),
    })
    expect(mockDb.profiles.update).not.toHaveBeenCalled()
  })
})

/*
 * A birth date is a fact; a stored age is a fact with an expiry date. These pin
 * the difference at the routes, because the decay is silent — nothing throws,
 * the gate simply keeps applying last year's answer to this year's person.
 *
 * Dates are built relative to today rather than hardcoded, so the suite does
 * not start failing on a birthday. One day back from today's date puts the
 * birthday just behind us, which makes the age exactly `years` and sidesteps
 * both the leap-day roll and the boundary `ageFrom` is separately tested on.
 */
const dobForAge = (years: number) => {
  const now = new Date()
  const d = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate() - 1))
  return d.toISOString().slice(0, 10)
}

const profileGetReq = () =>
  new NextRequest(`https://api.blendn.app/api/mobile/profiles/${USER}`)

describe("PUT /profiles/:userId — the age is derived, not remembered", () => {
  it("lets someone who signed up at 17 choose dating once they are 19", async () => {
    /*
     * The whole reason the column exists. `profiles.age` still says 17 because
     * that is what they typed two years ago and nothing has ever rewritten it,
     * so the gate went on refusing an adult indefinitely — and the only way out
     * was to lie about their age, which is the opposite of what the gate wants.
     */
    mockDb.profiles.findUnique.mockResolvedValue({
      age: 17,
      date_of_birth: new Date(dobForAge(19)),
      intent_default: [],
    })
    const res = await putProfile(profileReq({ intent_default: ["dating"] }), {
      params: Promise.resolve({ userId: USER }),
    })
    expect(res.status).toBe(200)
  })

  it("refuses a 17-year-old whose stored age says 30", async () => {
    // The same precedence in the direction that matters for safety. A stale or
    // invented number must not be able to outvote the date.
    mockDb.profiles.findUnique.mockResolvedValue({
      age: 30,
      date_of_birth: new Date(dobForAge(17)),
      intent_default: [],
    })
    const res = await putProfile(profileReq({ intent_default: ["dating"] }), {
      params: Promise.resolve({ userId: USER }),
    })
    expect(res.status).toBe(403)
    expect(mockDb.profiles.upsert).not.toHaveBeenCalled()
  })

  it("accepts a birth date and a dating intent in one request", async () => {
    // Onboarding sends both together, same as it does with `age`.
    mockDb.profiles.findUnique.mockResolvedValue({ age: null, date_of_birth: null, intent_default: [] })
    const res = await putProfile(
      profileReq({ dateOfBirth: dobForAge(21), intent_default: ["dating"] }),
      { params: Promise.resolve({ userId: USER }) }
    )
    expect(res.status).toBe(200)
  })

  it("refuses the same request when the date makes them 17", async () => {
    mockDb.profiles.findUnique.mockResolvedValue({ age: null, date_of_birth: null, intent_default: [] })
    const res = await putProfile(
      profileReq({ dateOfBirth: dobForAge(17), intent_default: ["dating"] }),
      { params: Promise.resolve({ userId: USER }) }
    )
    expect(res.status).toBe(403)
  })

  it("writes the date and refreshes the number beside it", async () => {
    // Both, so the fallback stays usable and the dashboard column stays true.
    mockDb.profiles.findUnique.mockResolvedValue({ age: null, date_of_birth: null, intent_default: [] })
    await putProfile(profileReq({ dateOfBirth: dobForAge(28) }), {
      params: Promise.resolve({ userId: USER }),
    })
    const update = mockDb.profiles.upsert.mock.calls[0][0].update
    expect(update.date_of_birth).toBeInstanceOf(Date)
    expect(update.age).toBe(28)
  })

  it("strips dating when a corrected birth date puts them under 18", async () => {
    // The two-request bypass again, this time walked through the new field.
    mockDb.profiles.findUnique.mockResolvedValue({
      age: 25,
      date_of_birth: null,
      intent_default: ["dating", "networking"],
    })
    const res = await putProfile(profileReq({ dateOfBirth: dobForAge(16) }), {
      params: Promise.resolve({ userId: USER }),
    })
    expect(res.status).toBe(200)
    expect(mockDb.profiles.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ intent_default: ["networking"] }),
      })
    )
  })

  it("rejects a malformed date instead of quietly storing nothing", async () => {
    /*
     * `parseDateOfBirth` returns null for junk, and null is indistinguishable
     * from "not sent" at the write. Without the schema refusing it, a typo
     * would save nothing and the person would be told their profile saved.
     */
    for (const bad of ["not-a-date", "2026-02-30", "3000-01-01", dobForAge(9)]) {
      mockDb.profiles.upsert.mockClear()
      const res = await putProfile(profileReq({ dateOfBirth: bad }), {
        params: Promise.resolve({ userId: USER }),
      })
      expect(res.status).toBe(400)
      expect(mockDb.profiles.upsert).not.toHaveBeenCalled()
    }
  })
})

describe("GET /profiles/:userId — the date never leaves the server", () => {
  const profileRow = {
    id: USER,
    age: 17,
    date_of_birth: new Date(dobForAge(19)),
    interests: [],
    onboarded: true,
    work_field: null,
    bio: null,
    occupation: null,
    education: null,
    photos: [],
    location: null,
  }

  it("withholds date_of_birth from the owner's own profile", async () => {
    /*
     * Self is the branch that spreads the row, so it is the one a new column
     * leaks through by default. A birth date is materially more identifying
     * than an age and the client has no use for it — it did not need to be
     * echoed back to be stored.
     */
    mockDb.user.findUnique.mockResolvedValue({
      id: USER,
      email: "a@b.com",
      name: "A",
      image: null,
      createdAt: new Date(),
      profile: profileRow,
      user_interests: [],
    })
    const res = await getProfile(profileGetReq(), { params: Promise.resolve({ userId: USER }) })
    const body = await res.json()
    expect(body.data.profile).not.toHaveProperty("date_of_birth")
    // ...and the age it does return is the derived one, not the stale column.
    expect(body.data.profile.age).toBe(19)
  })

  it("withholds it from a stranger too, and still derives the age", async () => {
    mockAuth.mockResolvedValue({ userId: "99999999-9999-9999-9999-999999999999", email: "x@y.com" })
    mockDb.user.findUnique.mockResolvedValue({
      id: USER,
      email: "a@b.com",
      name: "A",
      image: null,
      createdAt: new Date(),
      profile: profileRow,
      user_interests: [],
    })
    const res = await getProfile(profileGetReq(), { params: Promise.resolve({ userId: USER }) })
    const body = await res.json()
    expect(body.data.profile).not.toHaveProperty("date_of_birth")
    expect(body.data.profile.age).toBe(19)
  })
})

/*
 * Orientation is shown only when two independent things are true.
 *
 * `show_orientation` is consent to show it at all — special-category data under
 * GDPR Article 9, so the column defaults false and silence is not consent.
 * `maySeeIdentity` is *who to*. They are different questions and the design
 * only asked one of them: the Figma frame is a single "Show on profile" switch,
 * which would publish orientation to any caller holding a token.
 *
 * That ordering is what these pin. This app withholds someone's real name and
 * photograph from anyone who has not matched, opened a conversation, or been
 * revealed to. A field more sensitive than a name cannot be less protected than
 * one, so all four combinations are worth stating rather than the happy path.
 */
describe("GET /profiles/:userId — orientation", () => {
  const STRANGER = "99999999-9999-9999-9999-999999999999"

  const rowWith = (show: boolean) => ({
    id: USER,
    age: 30,
    date_of_birth: null,
    orientation: "bisexual",
    show_orientation: show,
    gender: "woman",
    interested_in: ["man", "woman"],
    interests: [],
    onboarded: true,
    work_field: null,
    bio: null,
    occupation: null,
    education: null,
    photos: [],
    location: null,
  })

  const asViewer = (viewerId: string, show: boolean) => {
    mockAuth.mockResolvedValue({ userId: viewerId, email: "v@b.com" })
    mockDb.user.findUnique.mockResolvedValue({
      id: USER,
      email: "a@b.com",
      name: "A",
      image: null,
      createdAt: new Date(),
      profile: rowWith(show),
      user_interests: [],
    })
    return getProfile(profileGetReq(), { params: Promise.resolve({ userId: USER }) })
  }

  it("shows it when the switch is on and the viewer may see who they are", async () => {
    maySeeIdentity.mockResolvedValue(true)
    const body = await (await asViewer(STRANGER, true)).json()
    expect(body.data.profile.orientation).toBe("bisexual")
  })

  it("withholds it when the switch is on but the viewer is a stranger", async () => {
    /*
     * The case the design's single switch would have got wrong. Co-presence at
     * an event is enough to send someone a message request; it is deliberately
     * not enough to learn their name, and it is not enough for this either.
     */
    maySeeIdentity.mockResolvedValue(false)
    const body = await (await asViewer(STRANGER, true)).json()
    expect(body.data.profile).not.toHaveProperty("orientation")
  })

  it("withholds it when the switch is off, even from a match", async () => {
    // Consent is the other gate, and it is not implied by a relationship.
    maySeeIdentity.mockResolvedValue(true)
    const body = await (await asViewer(STRANGER, false)).json()
    expect(body.data.profile).not.toHaveProperty("orientation")
  })

  it("withholds it from a stranger with the switch off", async () => {
    maySeeIdentity.mockResolvedValue(false)
    const body = await (await asViewer(STRANGER, false)).json()
    expect(body.data.profile).not.toHaveProperty("orientation")
  })

  it("never shows gender or interested_in, whatever the switch says", async () => {
    /*
     * These are matching *inputs*. The compatibility they compute surfaces as a
     * tag on a card — "Both open to dating" — never as the values behind it.
     * The switch is about orientation and must not quietly widen its neighbours,
     * which is exactly how the original leak happened: a deny-list that shipped
     * this column and `gender` together to any authenticated caller.
     */
    maySeeIdentity.mockResolvedValue(true)
    const body = await (await asViewer(STRANGER, true)).json()
    expect(body.data.profile).not.toHaveProperty("gender")
    expect(body.data.profile).not.toHaveProperty("interested_in")
  })

  it("still shows the owner their own, switch or no switch", async () => {
    // `isSelf` short-circuits `maySeeIdentity`, and the whole row minus the
    // birth date goes back — otherwise the settings screen could not render the
    // switch in the state the person left it.
    maySeeIdentity.mockResolvedValue(false)
    const body = await (await asViewer(USER, false)).json()
    expect(body.data.profile.orientation).toBe("bisexual")
    expect(body.data.profile.show_orientation).toBe(false)
  })
})
