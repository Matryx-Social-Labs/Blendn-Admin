import { NextRequest } from "next/server"

/*
 * "Looking for: dating" is not recorded under 18 (SCRUM-294).
 *
 * Driven on staging: onboarding offered a 17-year-old the Dating card, and
 * `PUT /profiles/:id {"looking_for":["dating"]}` stored it — while the same
 * person's `intent_default: ["dating"]` is refused with "Dating is for 18+
 * only". `looking_for` is free text, so the gate compares without case.
 * Real route, real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/tigris", () => ({ deletePrefix: jest.fn().mockResolvedValue(0) }))
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeUser } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const route = require("@/app/api/mobile/profiles/[userId]/route") as typeof import("@/app/api/mobile/profiles/[userId]/route")

const users: string[] = []
afterAll(async () => {
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await cleanup(users, [])
  await closeDb()
})

async function person(label: string, dob: string) {
  const id = await makeUser(label)
  users.push(id)
  await db.profiles.create({ data: { id, name: label, date_of_birth: new Date(dob) } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, email) }
}

const put = (id: string, token: string, body: unknown) =>
  route.PUT(
    new NextRequest(`http://localhost/api/mobile/profiles/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ userId: id }) }
  )

const yearsAgo = (years: number) => {
  const d = new Date()
  d.setFullYear(d.getFullYear() - years)
  return d.toISOString().slice(0, 10)
}

it("refuses 'looking for: dating' from a 17-year-old, in any case, and writes nothing", async () => {
  const { id, token } = await person("ndl-minor", yearsAgo(17))
  for (const looking_for of [["dating"], ["friendship", "Dating"], [" DATING "]]) {
    const res = await put(id, token, { looking_for })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("Dating is for 18+ only. Your other choices are fine.")
  }
  expect((await db.profiles.findUniqueOrThrow({ where: { id } })).looking_for).toEqual([])

  // Their other choices are still theirs to make.
  expect((await put(id, token, { looking_for: ["friendship", "travel"] })).status).toBe(200)
  expect((await db.profiles.findUniqueOrThrow({ where: { id } })).looking_for).toEqual(["friendship", "travel"])
})

it("still records it for an adult", async () => {
  const { id, token } = await person("ndl-adult", yearsAgo(25))
  expect((await put(id, token, { looking_for: ["dating", "open"] })).status).toBe(200)
  expect((await db.profiles.findUniqueOrThrow({ where: { id } })).looking_for).toEqual(["dating", "open"])
})

it("takes 'dating' out of looking-for when the age drops below 18, and keeps the rest", async () => {
  const { id, token } = await person("ndl-drop", yearsAgo(25))
  expect((await put(id, token, { looking_for: ["Dating", "travel"] })).status).toBe(200)
  expect((await put(id, token, { dateOfBirth: yearsAgo(17) })).status).toBe(200)
  expect((await db.profiles.findUniqueOrThrow({ where: { id } })).looking_for).toEqual(["travel"])
})
