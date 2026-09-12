import { NextRequest } from "next/server"

/*
 * A text-only DM through the real route, against a real database.
 *
 * `media_url: mediaUrl` and `media_type: mediaType` are optional in the
 * schema, so both are undefined on every DM without a picture — which is
 * every DM — and `strictUndefinedChecks` refused the write. Sending the
 * first message after a match returned 500. No regex sees a bare variable;
 * this does: post, read the row.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { db, closeDb, makeUser, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const route = require("@/app/api/mobile/conversations/[conversationId]/messages/route") as
  typeof import("@/app/api/mobile/conversations/[conversationId]/messages/route")

const users: string[] = []
const conversations: string[] = []

afterAll(async () => {
  if (conversations.length) {
    await db.private_messages.deleteMany({ where: { conversation_id: { in: conversations } } })
    await db.private_conversations.deleteMany({ where: { id: { in: conversations } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function person(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  const user = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, user.email) }
}

it("writes a text-only message and serves it back", async () => {
  const a = await person("dm_a")
  const b = await person("dm_b")
  const conversation = await db.private_conversations.create({
    data: { user1_id: a.id, user2_id: b.id, user1_pseudonym: "Quiet Otter", user2_pseudonym: "Amber Fox" },
  })
  conversations.push(conversation.id)

  const res = await route.POST(
    new NextRequest(`http://localhost/api/mobile/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${a.token}` },
      body: JSON.stringify({ text: "corner table is the best seat" }),
    }),
    { params: Promise.resolve({ conversationId: conversation.id }) }
  )
  expect([200, 201]).toContain(res.status)
  const body = (await res.json()) as { data: { id: string } }
  const row = await db.private_messages.findUniqueOrThrow({ where: { id: body.data.id } })
  expect(row).toMatchObject({ message_text: "corner table is the best seat", media_url: null, media_type: null })
})
