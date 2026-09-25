import { NextRequest } from "next/server"
import bcrypt from "bcryptjs"
import { readFileSync } from "fs"
import { join } from "path"
import type { NextAuthOptions } from "next-auth"

/*
 * One inbox is one account, whatever the case (SCRUM-328).
 *
 * Driven on staging: a signup as "Delivered+SK-0924a-3@…" was stored as
 * typed. Signing in as "delivered+sk-0924a-3@…" said "Invalid email or
 * password"; forgot-password, which lowercases, found nobody and issued no
 * link — to the very address the person signed up with; and a second signup
 * in lowercase made a second account for the same inbox.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ ...jest.requireActual("@/lib/auth"), getAuth: () => mockGetAuth() }))
import { authOptions } from "@/lib/auth"
import { createRoleUser } from "@/lib/admin-role-actions"
import { findOrCreateAppleUser, findOrCreateGoogleUser } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, testId } from "./helpers"
/* eslint-disable @typescript-eslint/no-require-imports */
const signupRoute = require("@/app/api/mobile/auth/signup/route") as typeof import("@/app/api/mobile/auth/signup/route")
const signinRoute = require("@/app/api/mobile/auth/signin/route") as typeof import("@/app/api/mobile/auth/signin/route")
const forgotRoute = require("@/app/api/auth/forgot-password/route") as typeof import("@/app/api/auth/forgot-password/route")
/* eslint-enable @typescript-eslint/no-require-imports */

type Authorize = (c: { email: string; password: string }) => Promise<{ id: string } | null>
const authorize = (authOptions as NextAuthOptions & { providers: { options: { authorize: Authorize } }[] }).providers[0]
  .options.authorize

const PASSWORD = "orchard-lantern-quiet-42"
const users: string[] = []
afterAll(async () => {
  await db.password_reset_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.user_oauth_accounts.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, [])
  await closeDb()
})

// A fresh network per request keeps the per-IP limiters out of the way.
let ip = 0
const post = (path: string, body: unknown) =>
  new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": `10.32.8.${++ip}` },
    body: JSON.stringify(body),
  })

/** `Itest_label_abc12345@Case.Test` — the case a person might type. */
const mixedCase = (label: string) => {
  const id = testId(label)
  return `${id[0].toUpperCase()}${id.slice(1)}@Case.Test`
}

async function passwordUser(email: string, role: "attendee" | "organizer" = "attendee") {
  const user = await db.user.create({
    data: { email, name: "Case", role, password: await bcrypt.hash(PASSWORD, 4) },
    select: { id: true },
  })
  users.push(user.id)
  return user.id
}

describe("signup and sign-in", () => {
  const typed = mixedCase("eio-signup")

  it("stores a signup in lowercase", async () => {
    const res = await signupRoute.POST(post("/api/mobile/auth/signup", { email: typed, password: PASSWORD, name: "Case" }))
    expect(res.status).toBe(201)
    const row = await db.user.findUniqueOrThrow({ where: { email: typed.toLowerCase() }, select: { id: true } })
    users.push(row.id)
  })

  it("signs in whatever case is typed", async () => {
    for (const email of [typed, typed.toLowerCase(), typed.toUpperCase()]) {
      const res = await signinRoute.POST(post("/api/mobile/auth/signin", { email, password: PASSWORD }))
      expect(res.status).toBe(200)
    }
  })

  it("refuses a second account for the same inbox in another case", async () => {
    const res = await signupRoute.POST(
      post("/api/mobile/auth/signup", { email: typed.toUpperCase(), password: PASSWORD, name: "Case" })
    )
    expect(res.status).toBe(409)
  })

  it("issues a reset link to the address as it was typed at signup", async () => {
    await forgotRoute.POST(post("/api/auth/forgot-password", { email: typed }))
    const user = await db.user.findUniqueOrThrow({ where: { email: typed.toLowerCase() }, select: { id: true } })
    expect(await db.password_reset_tokens.count({ where: { user_id: user.id } })).toBe(1)
  })
})

it("lets an operator into the dashboard whatever case they type", async () => {
  const typed = mixedCase("eio-dash")
  const id = await passwordUser(typed.toLowerCase(), "organizer")
  await expect(authorize({ email: typed, password: PASSWORD })).resolves.toMatchObject({ id })
})

it("links Google to the password account whatever case Google reports", async () => {
  const typed = mixedCase("eio-google")
  const id = await passwordUser(typed.toLowerCase())
  const result = await findOrCreateGoogleUser({
    sub: testId("gsub"), email: typed, email_verified: true, aud: "a", iss: "i", exp: 0, iat: 0,
  })
  expect(result).toMatchObject({ userId: id, isNewUser: false })
})

it("links Apple to the password account whatever case Apple reports", async () => {
  const typed = mixedCase("eio-apple")
  const id = await passwordUser(typed.toLowerCase())
  const result = await findOrCreateAppleUser({ sub: testId("asub"), email: typed, aud: "a", iss: "i", exp: 0, iat: 0 })
  expect(result).toMatchObject({ userId: id, isNewUser: false })
})

it("creates an operator account in lowercase, and refuses the same inbox in another case", async () => {
  mockGetAuth.mockResolvedValue({ user: { id: "admin", role: "app_admin" } })
  const typed = mixedCase("eio-role")
  const created = await createRoleUser("Role", typed, "organizer")
  users.push((await db.user.findUniqueOrThrow({ where: { email: typed.toLowerCase() }, select: { id: true } })).id)
  expect(created.email).toBe(typed.toLowerCase())
  await expect(createRoleUser("Role", typed.toUpperCase(), "organizer")).rejects.toThrow("Email already in use")
})

describe("the migration that lowercases what is already stored", () => {
  it("lowercases an address, but leaves one whose lowercase twin already exists for a person to merge", async () => {
    const sql = readFileSync(
      join(__dirname, "../../prisma/migrations/20260925210000_email_is_one_identity/migration.sql"),
      "utf8"
    )
    const solo = mixedCase("eio-solo")
    const twin = mixedCase("eio-twin")
    const soloId = await passwordUser(solo)
    const twinId = await passwordUser(twin)
    const lowerTwinId = await passwordUser(twin.toLowerCase())
    // Two spellings and no lowercase row: lowercasing both would collide on
    // the unique constraint and fail the deploy.
    const pair = mixedCase("eio-pair")
    const pairIds = [await passwordUser(pair), await passwordUser(pair.toUpperCase())]

    await db.$executeRawUnsafe(sql)

    const email = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })).email
    expect(await email(soloId)).toBe(solo.toLowerCase())
    expect(await email(twinId)).toBe(twin)
    expect(await email(lowerTwinId)).toBe(twin.toLowerCase())
    expect([await email(pairIds[0]), await email(pairIds[1])]).toEqual([pair, pair.toUpperCase()])
  })
})
