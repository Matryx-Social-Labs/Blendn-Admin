import { NextRequest } from "next/server"
import bcrypt from "bcryptjs"

/*
 * The per-account sign-in limit: 10 attempts in 15 minutes per email, from
 * however many addresses (SCRUM-450).
 *
 * It exists for credential stuffing spread across many IPs, which the per-IP
 * limit (5 in 15 minutes) never sees. From one client the per-IP limit always
 * fires first, so the SCRUM-265 sweep on staging could not reach it, and
 * nothing tested it. Here almost every request carries an address of its own,
 * so the per-IP limit stays out of the way. A 429 says which limit answered:
 * `X-RateLimit-Limit` is 10 for the account's, 5 for the address's.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { clearSigninCounters } from "@/lib/dashboard-signin-limits"
import { closeDb, db, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const signinRoute = require("@/app/api/mobile/auth/signin/route") as
  typeof import("@/app/api/mobile/auth/signin/route")

const PASSWORD = "orchard-lantern-quiet-42"
const users: string[] = []

afterAll(async () => {
  await db.mobile_refresh_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function account() {
  const id = testId("signin_acct")
  const email = `${id}@itest.invalid`
  await db.user.create({ data: { id, email, name: "Limit", role: "attendee", password: await bcrypt.hash(PASSWORD, 4) } })
  users.push(id)
  return email
}

// One attempt per address; the second octet is per run, in case a Redis outlives it.
const net = `10.${Math.floor(Math.random() * 200) + 50}`
let n = 0
const nextIp = () => `${net}.0.${++n}`
const signin = (email: string, password: string, ip = nextIp(), knownDevice?: string) =>
  signinRoute.POST(
    new NextRequest("http://localhost/api/mobile/auth/signin", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": ip },
      body: JSON.stringify({ email, password, ...(knownDevice !== undefined && { knownDevice }) }),
    })
  )

/** Refused by the account's limit (10, for 15 minutes), not the address's (5). */
async function expectAccountLimited(res: Response) {
  expect(res.status).toBe(429)
  expect(((await res.json()) as { errorCode?: string }).errorCode).toBe("RATE_LIMITED")
  expect(res.headers.get("X-RateLimit-Limit")).toBe("10")
  const retryAfter = Number(res.headers.get("Retry-After"))
  expect(retryAfter).toBeGreaterThan(14 * 60)
  expect(retryAfter).toBeLessThanOrEqual(15 * 60)
}

describe("the per-account sign-in limit", () => {
  it("refuses the 11th attempt on one email from a fresh address, even with the right password", async () => {
    const email = await account()
    for (let i = 0; i < 10; i++) expect((await signin(email, "wrong-guess")).status).toBe(401)

    const fresh = `${net}.1.1`
    await expectAccountLimited(await signin(email, PASSWORD, fresh))
    // The same inbox in capitals is the same account, and the same bucket.
    expect((await signin(email.toUpperCase(), PASSWORD, `${net}.1.2`)).status).toBe(429)
    // The limit is the account's: another email from the same address is still answered.
    expect((await signin(await account(), "wrong-guess", fresh)).status).toBe(401)
  })

  it("counts an email nobody has, so the limit tells nobody which accounts exist", async () => {
    const email = `nobody-${testId("signin_acct")}@itest.invalid`
    for (let i = 0; i < 10; i++) expect((await signin(email, "wrong-guess")).status).toBe(401)
    await expectAccountLimited(await signin(email, "wrong-guess"))
  })

  it("lets the 10th attempt through, so a person who mistyped nine times still gets in", async () => {
    const email = await account()
    for (let i = 0; i < 9; i++) expect((await signin(email, "wrong-guess")).status).toBe(401)
    expect((await signin(email, PASSWORD)).status).toBe(200)
  })

  /*
   * Only failures are counted, and a reset starts the account over (SCRUM-944 part 1, owner row A-18, decided by lean on
   * 2026-10-31; reverse if wanted). Successes used to count, so two bursts of wrong guesses from strangers plus the owner's
   * own sign-ins kept the right password at 429, and a completed reset did not clear this window.
   */
  it("does not count a right password", async () => {
    const email = await account()
    for (let i = 0; i < 12; i++) expect((await signin(email, PASSWORD)).status).toBe(200)
    expect((await signin(email, "wrong-guess")).status).toBe(401)
  })

  it("starts over after a completed password reset", async () => {
    const email = await account()
    for (let i = 0; i < 10; i++) expect((await signin(email, "wrong-guess")).status).toBe(401)
    await expectAccountLimited(await signin(email, PASSWORD))
    await clearSigninCounters(email)
    expect((await signin(email, PASSWORD)).status).toBe(200)
  })

  /*
   * The known-device escape (owner ruling A-18, 2026-11-01): a phone that has signed in to this account before is not
   * locked out by strangers' wrong guesses. A right sign-in returns `knownDevice`, a signed proof for that email only;
   * presenting it skips the account's window (the per-IP limit still applies, and the password is still needed).
   */
  it("lets a phone that signed in before past a lockout strangers caused", async () => {
    const email = await account()
    const proof = ((await (await signin(email, PASSWORD)).json()) as { data: { knownDevice?: string } }).data.knownDevice
    expect(typeof proof).toBe("string")
    for (let i = 0; i < 10; i++) expect((await signin(email, "wrong-guess")).status).toBe(401)
    await expectAccountLimited(await signin(email, PASSWORD))

    expect((await signin(email, PASSWORD, nextIp(), proof)).status).toBe(200)
    // Still a password check: the proof waives the window, not the credential.
    expect((await signin(email, "wrong-guess", nextIp(), proof)).status).toBe(401)
  })

  it("does not accept one account's proof for another, or a forged one", async () => {
    const [mine, theirs] = [await account(), await account()]
    const proof = ((await (await signin(mine, PASSWORD)).json()) as { data: { knownDevice: string } }).data.knownDevice
    for (let i = 0; i < 10; i++) expect((await signin(theirs, "wrong-guess")).status).toBe(401)
    await expectAccountLimited(await signin(theirs, PASSWORD, nextIp(), proof))
    await expectAccountLimited(await signin(theirs, PASSWORD, nextIp(), `${Date.now()}.forged`))
  })
})
