import { profileForSelfResponse } from "@/lib/self-profile"

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
