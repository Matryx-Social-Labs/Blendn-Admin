/*
 * `PUT /profiles/:id` takes a home region from the account's own country
 * (SCRUM-711, SCRUM-1082): a Toronto account picks a province and not an Indian
 * state, a Bengaluru account the other way round. An account with no home city
 * keeps today's rule (any region we list), so installed builds still save.
 */
import { NextRequest } from "next/server"

import { signAccessToken } from "@/lib/mobile-auth"
import { forgetCityCatalogue } from "@/lib/cities"
import { cleanup, closeDb, db, makeUser, onboard } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const profileRoute = require("@/app/api/mobile/profiles/[userId]/route") as typeof import("@/app/api/mobile/profiles/[userId]/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
beforeAll(() => forgetCityCatalogue())
afterAll(async () => {
  await cleanup(users, [])
  await closeDb()
})

async function account(label: string, homeCity: string | null) {
  const id = await makeUser(label)
  users.push(id)
  await onboard(id)
  if (homeCity) {
    const city = await db.cities.findUniqueOrThrow({ where: { slug: homeCity }, select: { id: true } })
    await db.profiles.update({ where: { id }, data: { home_city_id: city.id } })
  }
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, email) }
}

async function put(who: { id: string; token: string }, body: Record<string, unknown>) {
  const res = await profileRoute.PUT(
    new NextRequest(`http://localhost/api/mobile/profiles/${who.id}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${who.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ userId: who.id }) }
  )
  return { status: res.status, body: (await res.json()) as { error?: string } }
}
const stored = async (id: string) => (await db.profiles.findUniqueOrThrow({ where: { id }, select: { home_state: true } })).home_state

it("a Toronto account picks a province, and is refused an Indian state with the word for its regions", async () => {
  const who = await account("hrc-toronto", "toronto")
  expect((await put(who, { home_state: "ontario" })).status).toBe(200)
  expect(await stored(who.id)).toBe("ontario")

  const refused = await put(who, { home_state: "kerala" })
  expect(refused.status).toBe(400)
  expect(JSON.stringify(refused.body)).toContain("province")
  expect(await stored(who.id)).toBe("ontario")
})

it("a Bengaluru account picks a state, and is refused a province", async () => {
  const who = await account("hrc-blr", "bengaluru")
  expect((await put(who, { home_state: "kerala" })).status).toBe(200)
  expect((await put(who, { home_state: "quebec" })).status).toBe(400)
  expect(await stored(who.id)).toBe("kerala")
})

it("'Grew up abroad' and clearing it are fine anywhere", async () => {
  const who = await account("hrc-abroad", "toronto")
  expect((await put(who, { home_state: "abroad" })).status).toBe(200)
  expect((await put(who, { home_state: null })).status).toBe(200)
  expect(await stored(who.id)).toBeNull()
})

it("the region is checked against the home city sent in the same save", async () => {
  const who = await account("hrc-move", "bengaluru")
  expect((await put(who, { homeCitySlug: "toronto", home_state: "ontario" })).status).toBe(200)
  expect(await stored(who.id)).toBe("ontario")
  expect((await put(who, { homeCitySlug: "mumbai", home_state: "ontario" })).status).toBe(400)
})

it("an account with no home city keeps today's rule: any region we list, never an unknown slug", async () => {
  const who = await account("hrc-none", null)
  expect((await put(who, { home_state: "kerala" })).status).toBe(200)
  expect((await put(who, { home_state: "ontario" })).status).toBe(200)
  expect((await put(who, { home_state: "atlantis" })).status).toBe(400)
})
