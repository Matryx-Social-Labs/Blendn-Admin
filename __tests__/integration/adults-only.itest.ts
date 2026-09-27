import { NextRequest } from "next/server"

/*
 * Blend'n is 18+ (SCRUM-330). The store listings said so; the product took 13.
 *
 * The owner's ruling, 2026-09-27: a new account is an adult. Email sign-up
 * needs an age of 18 or over; a Google or Apple account, which arrives with no
 * age, cannot finish onboarding until a birth date of 18+ is on file; the
 * server refuses any new age or birth date under 18. Accounts made before the
 * ruling are left alone — an onboarded 16-year-old keeps using the app.
 * Real routes, real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/tigris", () => ({ deletePrefix: jest.fn().mockResolvedValue(0) }))
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeUser, testId } from "./helpers"
/* eslint-disable @typescript-eslint/no-require-imports */
const signupRoute = require("@/app/api/mobile/auth/signup/route") as typeof import("@/app/api/mobile/auth/signup/route")
const profileRoute = require("@/app/api/mobile/profiles/[userId]/route") as typeof import("@/app/api/mobile/profiles/[userId]/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const PASSWORD = "orchard-lantern-quiet-42"
const users: string[] = []
afterAll(async () => {
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await cleanup(users, [])
  await closeDb()
})

// A fresh network per request keeps the per-IP sign-up limiter out of the way.
let ip = 0
const signup = (body: Record<string, unknown>) =>
  signupRoute.POST(
    new NextRequest("http://localhost/api/mobile/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": `10.33.0.${++ip}` },
      body: JSON.stringify({ password: PASSWORD, name: "Adult", ...body }),
    })
  )

const put = (id: string, token: string, body: unknown) =>
  profileRoute.PUT(
    new NextRequest(`http://localhost/api/mobile/profiles/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ userId: id }) }
  )

const bornYearsAgo = (years: number) => {
  const d = new Date()
  d.setUTCFullYear(d.getUTCFullYear() - years)
  return d.toISOString().slice(0, 10)
}

/** An account as Google or Apple leaves it: a profile, no age, not onboarded. */
async function person(label: string, profile: { age?: number; onboarded: boolean }) {
  const id = await makeUser(label)
  users.push(id)
  await db.profiles.create({ data: { id, name: label, ...profile } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, email) }
}

const errorsOf = async (res: Response) =>
  ((await res.json()) as { errors?: { field: string; message: string }[] }).errors ?? []

describe("email sign-up", () => {
  it("refuses a sign-up with no age, and says why", async () => {
    const email = `${testId("ao-noage")}@adults.test`
    const res = await signup({ email })

    expect(res.status).toBe(400)
    expect(await errorsOf(res)).toContainEqual({ field: "age", message: expect.stringContaining("18 and over") })
    expect(await db.user.findUnique({ where: { email } })).toBeNull()
  })

  it("refuses a 17-year-old and writes no account", async () => {
    const email = `${testId("ao-17")}@adults.test`
    const res = await signup({ email, age: 17 })

    expect(res.status).toBe(400)
    expect(await errorsOf(res)).toContainEqual({ field: "age", message: expect.stringContaining("18 and over") })
    expect(await db.user.findUnique({ where: { email } })).toBeNull()
  })

  it("admits an 18-year-old", async () => {
    const email = `${testId("ao-18")}@adults.test`
    const res = await signup({ email, age: 18 })

    expect(res.status).toBe(201)
    const row = await db.user.findUniqueOrThrow({ where: { email }, select: { id: true, profile: { select: { age: true } } } })
    users.push(row.id)
    expect(row.profile?.age).toBe(18)
  })
})

describe("finishing onboarding", () => {
  it("holds an account with no age at onboarding", async () => {
    const { id, token } = await person("ao-oauth", { onboarded: false })
    const res = await put(id, token, { onboarded: true })

    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toContain("18 and over")
    expect((await db.profiles.findUniqueOrThrow({ where: { id } })).onboarded).toBe(false)
  })

  it("refuses a birth date under 18, and stores none of it", async () => {
    const { id, token } = await person("ao-dob17", { onboarded: false })
    const res = await put(id, token, { dateOfBirth: bornYearsAgo(17), onboarded: true })

    expect(res.status).toBe(400)
    const row = await db.profiles.findUniqueOrThrow({ where: { id } })
    expect(row.date_of_birth).toBeNull()
    expect(row.onboarded).toBe(false)
  })

  it("refuses an age under 18", async () => {
    const { id, token } = await person("ao-age17", { onboarded: false })
    const res = await put(id, token, { age: 17 })

    expect(res.status).toBe(400)
    expect((await db.profiles.findUniqueOrThrow({ where: { id } })).age).toBeNull()
  })

  it("lets an adult finish", async () => {
    const { id, token } = await person("ao-dob25", { onboarded: false })
    const res = await put(id, token, { dateOfBirth: bornYearsAgo(25), onboarded: true })

    expect(res.status).toBe(200)
    const row = await db.profiles.findUniqueOrThrow({ where: { id } })
    expect(row.onboarded).toBe(true)
    expect(row.date_of_birth).not.toBeNull()
  })
})

describe("accounts made before the ruling", () => {
  it("leaves an onboarded minor able to edit their profile", async () => {
    const { id, token } = await person("ao-teen", { age: 16, onboarded: true })
    const res = await put(id, token, { bio: "still here", onboarded: true })

    expect(res.status).toBe(200)
    expect((await db.profiles.findUniqueOrThrow({ where: { id } })).bio).toBe("still here")
  })
})
