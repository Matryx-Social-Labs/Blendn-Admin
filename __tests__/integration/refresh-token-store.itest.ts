import { db, closeDb, makeUser, testId } from "./helpers"
import { storeRefreshToken, signRefreshToken } from "@/lib/mobile-auth"

/**
 * Storing a refresh token, against a real Postgres.
 *
 * This is the test that had to exist against a real database rather than a
 * mock, because the defect it covers is invisible to both `tsc` and the unit
 * suite.
 *
 * `strictUndefinedChecks` turns an explicit `undefined` from "leave this field
 * alone" into a runtime error. `storeRefreshToken`'s `deviceInfo` is optional,
 * so every caller that omitted it was passing `undefined` — and **every
 * authentication path stores a refresh token through here**. Signup, signin and
 * refresh all returned 500 on staging at once; nobody could obtain a token.
 *
 * `tsc` is silent because the field is optional. The unit suite is silent
 * because it mocks `@/lib/db`. Only a real client raises it, which is why this
 * lives here.
 */
const users: string[] = []

afterAll(async () => {
  if (users.length) {
    await db.mobile_refresh_tokens.deleteMany({ where: { user_id: { in: users } } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  }
  await closeDb()
})

describe("storing a refresh token", () => {
  it("succeeds when no device info is given", async () => {
    /*
     * The case that broke. Most callers do not send device info, so this is the
     * ordinary path rather than an edge one.
     */
    const id = await makeUser(testId("rt-none"))
    users.push(id)

    const token = signRefreshToken(id, `${id}@itest.invalid`)
    await expect(storeRefreshToken(id, token)).resolves.not.toThrow()

    const rows = await db.mobile_refresh_tokens.findMany({ where: { user_id: id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].device_info).toBeNull()
  })

  it("stores device info when it is given", async () => {
    const id = await makeUser(testId("rt-some"))
    users.push(id)

    const token = signRefreshToken(id, `${id}@itest.invalid`)
    await storeRefreshToken(id, token, { platform: "ios" })

    const rows = await db.mobile_refresh_tokens.findMany({ where: { user_id: id } })
    expect(rows[0].device_info).toEqual({ platform: "ios" })
  })

  it("refuses a token with no jti, rather than writing an unrevocable row", async () => {
    /*
     * `jti` is what rotation and revocation key on. A row without one could
     * never be revoked, so this throws rather than storing it.
     */
    const id = await makeUser(testId("rt-nojti"))
    users.push(id)
    await expect(storeRefreshToken(id, "not-a-jwt")).rejects.toThrow()
  })
})
