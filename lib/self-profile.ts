import { ageFrom } from "@/lib/age"
import { normalizeLocationToCity } from "@/lib/location"

/**
 * The profile as an auth response should carry it.
 *
 * Seven places spread the whole `profiles` row into a response: the five auth
 * routes (signin, signup, session, google, apple) and both `include=profile`
 * branches of `GET /events`. That spread is a
 * **deny-list**: every column added to the model afterwards ships to the client
 * automatically, and nobody has to decide that it should.
 *
 * `date_of_birth` is the column that made the cost concrete. It went out in
 * every sign-in and every session check the day it was added, purely because
 * nothing named the fields. It is materially more identifying than the age
 * derived from it — a standard security-question answer, and half of an
 * identity-theft pair — while the age is not, and the client has never needed
 * the date to do anything.
 *
 * This is the same fix already applied to `GET /profiles/:userId`, factored out
 * rather than written a seventh time. Destructuring rather than an allow-list,
 * deliberately: these are all self-scoped responses, so a new column reaching
 * its own owner is right by default. **The withholding is the decision**, and
 * it is one name long.
 */
export function profileForSelfResponse<
  T extends { date_of_birth?: Date | null; age?: number | null },
>(profile: T | null | undefined) {
  if (!profile) return null
  const { date_of_birth: _dob, ...rest } = profile
  // Derived, so the number is true today rather than on the day they signed up.
  // A stale `age` here would disagree with every other route in the API.
  return { ...rest, age: ageFrom(profile) }
}

/**
 * The `include=profile` envelope: the caller's own user row with a shaped,
 * location-normalised profile inside it.
 *
 * Written once because it was written twice — `GET /events` builds this in two
 * branches, byte-identical but at different indent levels. Adding
 * `profileForSelfResponse` to them caught one and missed the other, and the
 * miss survived a clean typecheck, a green suite and a code review, because
 * nothing about a duplicated block says it is duplicated.
 *
 * It was found by asking the deployed API for the response and looking at it.
 */
export async function selfProfileEnvelope<
  T extends { profile?: { location: string | null; date_of_birth?: Date | null; age?: number | null } | null },
>(user: T | null) {
  if (!user?.profile) return user
  return {
    ...user,
    profile: {
      ...profileForSelfResponse(user.profile),
      location: await normalizeLocationToCity(user.profile.location),
    },
  }
}
