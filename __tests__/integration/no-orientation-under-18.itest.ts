import { NextRequest } from "next/server"

/*
 * Orientation is not collected under 18 (SCRUM-200).
 *
 * Driven on iOS: a 17-year-old was shown the Orientation step, and
 * `PUT /profiles/:id` stored `{gay,bisexual}` with `show_orientation: true`
 * for the row — special-category data from a child, for dating, which the
 * same child is refused everywhere else. Real route, real rows.
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

const seventeen = () => {
  const d = new Date()
  d.setFullYear(d.getFullYear() - 17)
  return d.toISOString().slice(0, 10)
}
const twentyFive = () => {
  const d = new Date()
  d.setFullYear(d.getFullYear() - 25)
  return d.toISOString().slice(0, 10)
}

it("refuses orientation, interested-in and the consent switch for a 17-year-old, and writes nothing", async () => {
  const { id, token } = await person("nou-minor", seventeen())
  for (const body of [
    { orientations: ["gay", "bisexual"] },
    { interested_in: ["man"] },
    { show_orientation: true },
  ]) {
    const res = await put(id, token, body)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/18\+ only/)
  }
  const row = await db.profiles.findUniqueOrThrow({ where: { id } })
  expect(row.orientations).toEqual([])
  expect(row.interested_in).toEqual([])
  expect(row.show_orientation).toBe(false)

  // The rest of the profile is still theirs to edit.
  expect((await put(id, token, { bio: "hi" })).status).toBe(200)
})

it("still stores it for an adult", async () => {
  const { id, token } = await person("nou-adult", twentyFive())
  expect((await put(id, token, { orientations: ["queer"], show_orientation: true })).status).toBe(200)
  const row = await db.profiles.findUniqueOrThrow({ where: { id } })
  expect(row.orientations).toEqual(["queer"])
  expect(row.show_orientation).toBe(true)
})

it("takes the stored orientation with it when the age drops below 18", async () => {
  const { id, token } = await person("nou-drop", twentyFive())
  expect((await put(id, token, { orientations: ["gay"], show_orientation: true })).status).toBe(200)
  // The corrected date of birth is accepted; the orientation does not survive it.
  expect((await put(id, token, { dateOfBirth: seventeen() })).status).toBe(200)
  const row = await db.profiles.findUniqueOrThrow({ where: { id } })
  expect(row.orientations).toEqual([])
  expect(row.interested_in).toEqual([])
  expect(row.show_orientation).toBe(false)
})
