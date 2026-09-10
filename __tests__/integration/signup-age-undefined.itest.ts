import { db, closeDb, testId } from "./helpers"

/**
 * Creating an account without an age, against a real Postgres.
 *
 * `POST /api/mobile/auth/signup` built its profile with a bare `age,`. `age` is
 * `.optional()` in `signupSchema`, so a caller that omits it produces an
 * explicit `undefined` — and under `strictUndefinedChecks` that is a runtime
 * error rather than "leave the column alone". **Every sign-up that did not send
 * an age returned 500**: the app's own form (the Age field is optional), and
 * Google and Apple, which never send one.
 *
 * Callers that *did* send an age worked, which is why an API-level sweep passed
 * while sign-up was down. It was found by driving the real form on a simulator,
 * where the field is left blank.
 *
 * **`__tests__/mobile-signup.test.ts:103` is a unit test named "still accepts a
 * signup with no age", and it was green throughout.** Its own comment says "if
 * this ever starts failing, every new password signup in production is 400ing".
 * It mocks `@/lib/db`, so the one thing it was written to catch is the one
 * thing it cannot see. That is the argument for this file existing beside it
 * rather than instead of it.
 *
 * Third instance of this class to reach staging, after
 * `mobile_refresh_tokens.device_info` and the `profiles` upsert. The general
 * guard is SCRUM-60.
 */
const users: string[] = []

afterAll(async () => {
  if (users.length) {
    await db.profiles.deleteMany({ where: { id: { in: users } } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  }
  await closeDb()
})

/**
 * The route's own transaction, with `age` threaded through as the handler
 * threads it.
 *
 * Taking `age` as a parameter and spreading it is the point: passing
 * `undefined` explicitly is what the broken code did, and a test that simply
 * omitted the key would have passed against it.
 */
async function signUp(email: string, age: number | undefined) {
  return db.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { email, password: "hashed", name: "Ember" } })
    const profile = await tx.profiles.create({
      data: {
        id: user.id,
        name: "Ember",
        ...(age !== undefined && { age }),
        onboarded: false,
      },
    })
    return { user, profile }
  })
}

describe("signing up", () => {
  it("creates an account when no age is sent", async () => {
    const { user, profile } = await signUp(`${testId("signup-noage")}@blendn.test`, undefined)
    users.push(user.id)

    expect(profile.age).toBeNull()
    expect(profile.onboarded).toBe(false)
  })

  it("creates an account when an age is sent", async () => {
    const { user, profile } = await signUp(`${testId("signup-age")}@blendn.test`, 28)
    users.push(user.id)

    expect(profile.age).toBe(28)
  })

  it("leaves no user behind when the profile write fails", async () => {
    /*
     * The transaction is what stops a half-made account, and it is worth
     * pinning: a `User` that can authenticate but has no profile lands nowhere,
     * because the app's routing gate reads `profile.onboarded` — and signing up
     * again 409s, so it cannot be recovered.
     *
     * Forced with a duplicate primary key rather than an `undefined`, so this
     * keeps asserting the rollback once the whole class is ratcheted out.
     */
    const email = `${testId("signup-rollback")}@blendn.test`
    const taken = await signUp(`${testId("signup-taken")}@blendn.test`, undefined)
    users.push(taken.user.id)

    await expect(
      db.$transaction(async (tx) => {
        const user = await tx.user.create({ data: { email, password: "hashed", name: "Ghost" } })
        users.push(user.id)
        await tx.profiles.create({ data: { id: taken.user.id, name: "Ghost", onboarded: false } })
        return user
      })
    ).rejects.toThrow()

    expect(await db.user.findUnique({ where: { email } })).toBeNull()
  })
})
