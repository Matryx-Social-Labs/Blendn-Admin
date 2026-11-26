import { NextRequest } from "next/server"

/*
 * A suspended person's email or Google account cannot sign up again
 * (SCRUM-1172). Google and Apple, which prove the inbox, answer the suspended
 * sentence every sign-in gives; password sign-up answers exactly what a taken
 * address gets, so it never says who is suspended.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/mobile-auth", () => ({ ...jest.requireActual("@/lib/mobile-auth"), verifyGoogleIdToken: jest.fn(), verifyAppleIdToken: jest.fn() }))
import { SUSPENDED_MESSAGE, verifyAppleIdToken, verifyGoogleIdToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, testId } from "./helpers"
/* eslint-disable @typescript-eslint/no-require-imports */
const signupRoute = require("@/app/api/mobile/auth/signup/route") as typeof import("@/app/api/mobile/auth/signup/route")
const googleRoute = require("@/app/api/mobile/auth/google/route") as typeof import("@/app/api/mobile/auth/google/route")
const appleRoute = require("@/app/api/mobile/auth/apple/route") as typeof import("@/app/api/mobile/auth/apple/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const PASSWORD = "orchard-lantern-quiet-42"
const users: string[] = []
/** Every address a test asked to create: a regression that writes a row must not leave it behind. */
const attempted: string[] = []
afterAll(async () => {
  users.push(...(await db.user.findMany({ where: { email: { in: attempted.map((e) => e.toLowerCase()) } }, select: { id: true } })).map((u) => u.id))
  await db.user_oauth_accounts.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, [])
  await closeDb()
})

let ip = 0
const post = (path: string, body: unknown) =>
  new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": `10.33.8.${++ip}` },
    body: JSON.stringify(body),
  })
const signup = (email: string) => {
  attempted.push(email)
  return signupRoute.POST(post("/api/mobile/auth/signup", { email, password: PASSWORD, name: "Again", age: 30 }))
}
const google = (sub: string, email: string) => {
  attempted.push(email)
  jest.mocked(verifyGoogleIdToken).mockResolvedValueOnce({
    sub, email, email_verified: true, aud: "a", iss: "i", exp: 0, iat: 0,
  })
  return googleRoute.POST(post("/api/mobile/auth/google", { idToken: "t" }))
}
const apple = (sub: string, email: string) => {
  attempted.push(email)
  jest.mocked(verifyAppleIdToken).mockResolvedValueOnce({ sub, email, aud: "a", iss: "i", exp: 0, iat: 0 })
  return appleRoute.POST(post("/api/mobile/auth/apple", { identityToken: "t" }))
}

async function suspended(email: string, googleSub?: string) {
  const user = await db.user.create({
    data: {
      email,
      name: "Suspended",
      suspended_at: new Date(),
      ...(googleSub && { oauth_accounts: { create: { provider: "google", provider_id: googleSub, email } } }),
    },
    select: { id: true },
  })
  users.push(user.id)
  return user.id
}

async function expectSuspendedRefusal(res: Response) {
  expect(res.status).toBe(403)
  expect(await res.json()).toMatchObject({
    success: false,
    error: SUSPENDED_MESSAGE,
    errorCode: "FORBIDDEN",
    reasonCode: "ACCOUNT_SUSPENDED",
  })
}

describe("identity_email, the one definition (migration SQL)", () => {
  const key = async (email: string | null) =>
    (await db.$queryRaw<{ key: string | null }[]>`SELECT identity_email(${email}::text) AS "key"`)[0].key

  it.each([
    [" A.B+x@GoogleMail.com ", "ab@gmail.com"],
    ["A.B+x@Gmail.com", "ab@gmail.com"],
    ["a.b+x@company.com", "a.b@company.com"],
    ["Rhea.Kapoor+again@blendn.app", "rhea.kapoor@blendn.app"],
    ["+x@company.com", "+x@company.com"],
  ])("folds %s to %s", async (email, expected) => {
    expect(await key(email)).toBe(expected)
  })

  it.each([[null], [""], ["no-at-sign"]])("gives NULL for %p, which matches nobody", async (email) => {
    expect(await key(email)).toBeNull()
  })

  it("is IMMUTABLE and indexed", async () => {
    const [fn] = await db.$queryRaw<{ volatile: string }[]>`
      SELECT provolatile::text AS "volatile" FROM pg_proc WHERE proname = 'identity_email'`
    expect(fn.volatile).toBe("i")
    const [idx] = await db.$queryRaw<{ valid: boolean }[]>`
      SELECT indisvalid AS "valid" FROM pg_index WHERE indexrelid = '"User_identity_email_idx"'::regclass`
    expect(idx.valid).toBe(true)
  })
})

/** `itest_x_abc` → `it.est_x_abc`: the same Gmail inbox, the dots moved. */
const dotsMoved = (local: string) => `${local.slice(0, 2)}.${local.slice(2)}`

describe("sign-up", () => {
  /** What a taken address gets: the answer a suspended identity must be indistinguishable from. */
  async function takenAnswer() {
    const email = `${testId("taken")}@blendn.test`
    users.push((await db.user.create({ data: { email, name: "Taken" }, select: { id: true } })).id)
    const res = await signup(email)
    return { status: res.status, body: await res.json() }
  }

  it("answers a suspended Gmail inbox with a +tag and the dots moved as a taken address, and writes no row", async () => {
    const local = testId("sus-gmail")
    await suspended(`${local}@gmail.com`)
    const again = `${dotsMoved(local)}+again@GMAIL.com`

    const res = await signup(again)
    expect({ status: res.status, body: await res.json() }).toEqual(await takenAnswer())
    expect(res.status).toBe(409)
    expect(await db.user.count({ where: { email: again.toLowerCase() } })).toBe(0)
  })

  it("answers a suspended address on another domain with a +tag as a taken address", async () => {
    const local = testId("sus-work")
    await suspended(`${local}@blendn.test`)
    const res = await signup(`${local}+2@blendn.test`)
    expect({ status: res.status, body: await res.json() }).toEqual(await takenAnswer())
  })

  it("answers an active owner's +tag and a suspended owner's +tag byte for byte the same", async () => {
    const answer = async (suspendedAt: Date | null) => {
      const local = testId("owner")
      users.push((await db.user.create({ data: { email: `${local}@gmail.com`, name: "Owner", suspended_at: suspendedAt }, select: { id: true } })).id)
      const res = await signup(`${dotsMoved(local)}+q@gmail.com`)
      return { status: res.status, body: await res.text() }
    }
    const active = await answer(null)
    expect(active).toEqual(await answer(new Date()))
    expect(active.status).toBe(409)
  })

  it("lets a fresh email sign up (negative control)", async () => {
    const fresh = `${testId("fresh")}@gmail.com`
    const res = await signup(fresh)
    expect(res.status).toBe(201)
    users.push((await db.user.findUniqueOrThrow({ where: { email: fresh }, select: { id: true } })).id)
  })
})

describe("Google", () => {
  it("refuses a Google account whose sub is a suspended user's", async () => {
    const sub = testId("gsub")
    const email = `${testId("sus-gsub")}@gmail.com`
    await suspended(email, sub)
    await expectSuspendedRefusal(await google(sub, email))
  })

  it("refuses to create an account for a suspended person's Gmail inbox under a new sub, and writes no row", async () => {
    const local = testId("sus-gnew")
    await suspended(`${dotsMoved(local)}@gmail.com`)

    await expectSuspendedRefusal(await google(testId("gsub"), `${local}@gmail.com`))
    expect(await db.user.count({ where: { email: `${local}@gmail.com` } })).toBe(0)
  })

  it("still creates an account when only an active account holds the inbox under another spelling", async () => {
    const local = testId("active-g")
    users.push((await db.user.create({ data: { email: `${local}@gmail.com`, name: "Active" }, select: { id: true } })).id)
    const res = await google(testId("gsub"), `${dotsMoved(local)}@gmail.com`)
    expect(res.status).toBe(201)
  })

  it("creates a fresh Google account (negative control)", async () => {
    const email = `${testId("gfresh")}@gmail.com`
    const res = await google(testId("gsub"), email)
    expect(res.status).toBe(201)
    users.push((await db.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id)
  })
})

describe("Apple", () => {
  it("refuses to create an account for a suspended person's address with a +tag, and writes no row", async () => {
    const local = testId("sus-apple")
    await suspended(`${local}@icloud.test`)
    const again = `${local}+x@icloud.test`

    await expectSuspendedRefusal(await apple(testId("asub"), again))
    expect(await db.user.count({ where: { email: again } })).toBe(0)
  })

  it("creates a fresh Apple account (negative control)", async () => {
    const res = await apple(testId("asub"), `${testId("afresh")}@icloud.test`)
    expect(res.status).toBe(201)
  })
})
