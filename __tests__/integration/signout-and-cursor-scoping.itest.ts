import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken, signRefreshToken, storeRefreshToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/*
 * API L10 (security audit), two small ones:
 *  - sign-out revoked whatever refresh-token row the presented token's jti
 *    named, whoever owned it;
 *  - a chat `before` cursor was looked up by id alone, so a message id from
 *    another room moved this room's page (a timestamp oracle).
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const signout = require("@/app/api/mobile/auth/signout/route") as typeof import("@/app/api/mobile/auth/signout/route")
const messages = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
afterAll(async () => {
  await db.mobile_refresh_tokens.deleteMany({ where: { user_id: { in: users } } })
  if (events.length) await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

async function person(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

it("sign-out cannot revoke somebody else's refresh token", async () => {
  const alice = await person("so_a")
  const mallory = await person("so_m")
  const alicesRefresh = signRefreshToken(alice.id, `${alice.id}@itest.invalid`)
  await storeRefreshToken(alice.id, alicesRefresh)

  const res = await signout.POST(
    new NextRequest("http://localhost/api/mobile/auth/signout", {
      method: "POST",
      headers: { authorization: `Bearer ${mallory.token}`, "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: alicesRefresh }),
    })
  )
  expect(res.status).toBe(200)
  const row = await db.mobile_refresh_tokens.findFirstOrThrow({ where: { user_id: alice.id }, select: { revoked_at: true } })
  expect(row.revoked_at).toBeNull()
})

it("a chat cursor from another room does not move this room's page", async () => {
  const me = await person("cur_me")
  const host = await makeUser(testId("cur_host"), "organizer")
  users.push(host)
  const ev1 = await makeEvent(host)
  const ev2 = await makeEvent(host)
  events.push(ev1, ev2)
  const [g1, g2] = await Promise.all(
    [ev1, ev2].map((event_id) => db.chat_groups.create({ data: { event_id, name: "room", status: "active" }, select: { id: true } }))
  )
  await db.chat_group_members.create({ data: { chat_group_id: g1.id, user_id: me.id, status: "active", anonymous_name: testId("Otter") } })
  const t = (m: number) => new Date(Date.now() - m * 60_000)
  for (const m of [30, 20, 10]) {
    await db.chat_messages.create({ data: { chat_group_id: g1.id, user_id: host, content: `msg ${m}`, created_at: t(m) } })
  }
  const foreign = await db.chat_messages.create({ data: { chat_group_id: g2.id, user_id: host, content: "elsewhere", created_at: t(15) } })

  const res = await messages.GET(
    new NextRequest(`http://localhost/api/mobile/chat/groups/${g1.id}/messages?before=${foreign.id}`, { headers: { authorization: `Bearer ${me.token}` } }),
    { params: Promise.resolve({ chatGroupId: g1.id }) }
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data: { messages: unknown[] } }
  expect(body.data.messages).toHaveLength(3)
})
