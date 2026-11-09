import { NextRequest } from "next/server"

import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeUser } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const demandRoute = require("@/app/api/mobile/events/demand/route") as typeof import("@/app/api/mobile/events/demand/route")

/*
 * SCRUM-997, read back: a city_demand row written without a country (an older
 * app) gets one from the next open that sends it, and keeps it when a later
 * open sends none. Staging had Toronto | null | opens 2 → 6.
 */
const users: string[] = []
afterAll(async () => {
  await db.city_demand.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, [])
  await closeDb()
})

const open = (userId: string, body: unknown) =>
  demandRoute.POST(
    new NextRequest("http://localhost/api/mobile/events/demand", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${signAccessToken(userId, `${userId}@test.blendn`)}` },
      body: JSON.stringify(body),
    })
  )

it("fills a missing country from a later open, and never clears it", async () => {
  const me = await makeUser("demand-country")
  users.push(me)
  const row = () => db.city_demand.findFirstOrThrow({ where: { user_id: me }, select: { country: true, opens: true } })

  expect((await open(me, { city: "Toronto" })).status).toBe(200)
  expect(await row()).toEqual({ country: null, opens: 1 })

  expect((await open(me, { city: "Toronto", country: "CA" })).status).toBe(200)
  expect(await row()).toEqual({ country: "CA", opens: 2 })

  expect((await open(me, { city: "toronto" })).status).toBe(200)
  expect(await row()).toEqual({ country: "CA", opens: 3 })
})
