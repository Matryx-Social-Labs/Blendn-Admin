import { NextRequest } from "next/server"

/*
 * Deleting an account keeps the rooms of its board posts (step 7, E1).
 *
 * A board post's room holds other people's messages — the accepted askers' —
 * and whatever moderation hid or somebody reported in it, which the IT Rules
 * keep for 180 days. Erasure used to delete every post outright, and with
 * `board_post_id` cascading that took the room, the askers' messages and the
 * moderation flags with it, and left reports pointing at nothing. Now the FK is
 * RESTRICT and erasure keeps a post that has a room: off the board, its words
 * gone, the room archived with everything in it, and the door closed.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/tigris", () => ({
  deletePrefix: jest.fn().mockResolvedValue(0),
  deleteFile: jest.fn().mockResolvedValue(undefined),
  withdrawFromPublic: jest.fn().mockResolvedValue(undefined),
}))
import { signAccessToken } from "@/lib/mobile-auth"
import { canJoinChat } from "@/lib/socket-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, onboard, testId } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const accountRoute = require("@/app/api/mobile/account/route") as typeof import("@/app/api/mobile/account/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const messagesRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.moderation_flags.deleteMany({ where: { user_id: { in: users } } })
  await db.message_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
})

it("keeps the room, the asker's messages and the flags when the author deletes their account, and closes the door", async () => {
  const author = await makeUser(testId("bre-author"))
  const asker = await makeUser(testId("bre-asker"))
  users.push(author, asker)
  await onboard(author, asker)
  const eventId = await makeEvent(author)
  events.push(eventId)

  const post = await db.board_posts.create({ data: { event_id: eventId, author_id: author, kind: "offer", body: "Two seats", spaces_left: 1 } })
  const roomless = await db.board_posts.create({ data: { event_id: eventId, author_id: author, kind: "chat", body: "anyone?" } })
  await db.board_requests.create({
    data: { event_id: eventId, post_id: post.id, from_user_id: asker, to_user_id: author, status: "accepted", decided_at: new Date() },
  })
  const room = await db.chat_groups.create({ data: { kind: "board_post", board_post_id: post.id, name: "Car", status: "active" } })
  await db.chat_group_members.createMany({
    data: [
      { chat_group_id: room.id, user_id: author, status: "active", anonymous_name: testId("A") },
      { chat_group_id: room.id, user_id: asker, status: "active", anonymous_name: testId("B") },
    ],
  })
  const askerMessage = await db.chat_messages.create({ data: { chat_group_id: room.id, user_id: asker, content: "see you at 7" } })
  const authorMessage = await db.chat_messages.create({
    data: { chat_group_id: room.id, user_id: author, content: "something nasty", moderation_status: "hidden" },
  })
  await db.moderation_flags.create({
    data: { message_id: authorMessage.id, chat_group_id: room.id, user_id: author, source: "auto_keyword", categories: {}, confidence: 0.9, auto_action: "hidden" },
  })
  await db.message_reports.create({ data: { reporter_id: asker, message_id: authorMessage.id, message_type: "group", reason: "abuse" } })

  const { email } = await db.user.findUniqueOrThrow({ where: { id: author }, select: { email: true } })
  const res = await accountRoute.DELETE(
    new NextRequest("http://localhost/api/mobile/account", {
      method: "DELETE",
      headers: { "content-type": "application/json", authorization: `Bearer ${signAccessToken(author, email)}` },
    })
  )
  expect(res.status).toBe(200)

  // The room and everything in it survive; the room is archived.
  expect(await db.chat_groups.findUnique({ where: { id: room.id }, select: { status: true } })).toEqual({ status: "archived" })
  expect(await db.chat_messages.count({ where: { id: { in: [askerMessage.id, authorMessage.id] } } })).toBe(2)
  expect(await db.moderation_flags.count({ where: { message_id: authorMessage.id } })).toBe(1)
  expect(await db.message_reports.count({ where: { message_id: authorMessage.id } })).toBe(1)
  // The post stays as a row: off the board and without its words. The roomless one goes.
  const kept = await db.board_posts.findUniqueOrThrow({ where: { id: post.id }, select: { deleted_at: true, body: true } })
  expect(kept.deleted_at).not.toBeNull()
  expect(kept.body).toBe("")
  expect(await db.board_posts.count({ where: { id: roomless.id } })).toBe(0)
  // And the door says hidden.
  expect(await canJoinChat(asker, room.id)).toBe(false)
  const askerEmail = (await db.user.findUniqueOrThrow({ where: { id: asker }, select: { email: true } })).email
  const read = await messagesRoute.GET(
    new NextRequest(`http://localhost/api/mobile/chat/groups/${room.id}/messages`, {
      headers: { authorization: `Bearer ${signAccessToken(asker, askerEmail)}` },
    }),
    { params: Promise.resolve({ chatGroupId: room.id }) }
  )
  expect(read.status).toBe(404)
})
