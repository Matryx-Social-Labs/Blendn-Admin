jest.mock("@/lib/location", () => ({
  normalizeLocationToCity: jest.fn(async (l: string | null) => l),
}))

import { profileForSelfResponse, selfProfileEnvelope } from "@/lib/self-profile"

/*
 * The birth date does not leave the server, including in the responses that
 * hand someone their own profile back.
 *
 * This was found by making a real request to staging rather than by reading
 * code: signing up returned `"date_of_birth": null` in the body. Null, so
 * nothing leaked that day — but `POST /auth/signin` and `GET /auth/session`
 * take the same shape for accounts that *do* have one, so the date was in every
 * sign-in response and every session check from the moment the column existed.
 *
 * The cause is the same in all seven places: `{ ...profile }`. A spread is a
 * **deny-list**, so every column added to the model afterwards ships to the
 * client automatically and nobody has to decide that it should. Two of those
 * spreads were written by the same change that added the column.
 *
 * These tests are about the *shape* of what comes back, so they run against the
 * one function all seven now go through. `__tests__/age-routes.test.ts` covers
 * the profile GET separately, at the route.
 */

const row = {
  id: "p1",
  name: "Julian",
  age: 17,
  date_of_birth: new Date("2004-06-01T00:00:00.000Z"),
  bio: "hello",
  intent_default: ["networking"],
}

describe("profileForSelfResponse", () => {
  it("removes the birth date", () => {
    const shaped = profileForSelfResponse(row)
    expect(shaped).not.toHaveProperty("date_of_birth")
  })

  it("keeps everything else, because this is the owner's own profile", () => {
    // Not an allow-list on purpose. These responses are self-scoped, so a new
    // column reaching its own owner is right by default — the withholding is
    // the decision, and it is one name long.
    const shaped = profileForSelfResponse(row)
    expect(shaped).toMatchObject({
      id: "p1",
      name: "Julian",
      bio: "hello",
      intent_default: ["networking"],
    })
  })

  it("returns the derived age, not the stored one", () => {
    /*
     * The row says 17 and the date says otherwise. Every other route in the API
     * derives, so returning the column here would make the age in a sign-in
     * response disagree with the age in the profile response for the same
     * account — and the sign-in one is what the app caches.
     */
    const shaped = profileForSelfResponse(row)
    expect(shaped?.age).toBe(ageOf(row.date_of_birth))
    expect(shaped?.age).not.toBe(17)
  })

  it("falls back to the stored age for a row written before the column", () => {
    const shaped = profileForSelfResponse({ age: 24, date_of_birth: null })
    expect(shaped?.age).toBe(24)
  })

  it("passes null through", () => {
    // An account can exist without a profile row; the callers render `null`.
    expect(profileForSelfResponse(null)).toBeNull()
    expect(profileForSelfResponse(undefined)).toBeNull()
  })
})

function ageOf(dob: Date): number {
  const now = new Date()
  let years = now.getUTCFullYear() - dob.getUTCFullYear()
  const months = now.getUTCMonth() - dob.getUTCMonth()
  const days = now.getUTCDate() - dob.getUTCDate()
  if (months < 0 || (months === 0 && days < 0)) years -= 1
  return years
}

/*
 * The envelope, not just the shaper.
 *
 * `profileForSelfResponse` was correct and tested, and the leak survived
 * anyway: `GET /events?include=profile` builds this wrapper in two branches,
 * byte-identical but at different indent levels, and the fix reached one of
 * them. A clean typecheck, a green suite and the tests above all passed with
 * the second branch still sending the birth date.
 *
 * It was caught by asking staging for the response. These tests are the version
 * that does not need a deploy.
 */
describe("selfProfileEnvelope", () => {
  const user = {
    id: "u1",
    name: "Julian",
    profile: {
      id: "p1",
      location: "Bengaluru",
      age: 17,
      date_of_birth: new Date("2004-06-01T00:00:00.000Z"),
    },
  }

  it("strips the birth date from inside the envelope", async () => {
    const shaped = await selfProfileEnvelope(user)
    expect(shaped?.profile).not.toHaveProperty("date_of_birth")
  })

  it("derives the age inside the envelope too", async () => {
    // The whole reason the wrapper exists is that it is easy to shape the
    // outside and forget the inside.
    const shaped = await selfProfileEnvelope(user)
    expect(shaped?.profile?.age).not.toBe(17)
  })

  it("still normalises the location", async () => {
    const shaped = await selfProfileEnvelope(user)
    expect(shaped?.profile?.location).toBe("Bengaluru")
  })

  it("passes an account with no profile through untouched", async () => {
    const bare = { id: "u2", name: "No profile", profile: null }
    expect(await selfProfileEnvelope(bare)).toBe(bare)
    expect(await selfProfileEnvelope(null)).toBeNull()
  })
})
