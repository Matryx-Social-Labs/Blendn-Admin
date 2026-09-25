import { NextRequest } from "next/server"

/*
 * A closed pair is refused, not a server fault (SCRUM-300).
 *
 * Driven on staging in the A02 sweep: rohan and ananya had an accepted request
 * and a conversation she had closed with `unmatch`, and `POST /conversations`
 * from rohan answered 500 "Failed to create conversation" — Railway logged an
 * ERROR for what is an expected refusal. `openConversation` throws
 * `ConversationClosedError` for a closed pair; three of its four callers turn
 * that into an answer, this route did not. Real route, real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { signAccessToken } from "@/lib/mobile-auth"
import { openConversation } from "@/lib/conversations"
import { cleanup, closeDb, db, makeUser, testId } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const conversations = require("@/app/api/mobile/conversations/route") as typeof import("@/app/api/mobile/conversations/route")

const users: string[] = []
afterAll(async () => {
  await db.message_requests.deleteMany({ where: { sender_id: { in: users } } })
  await cleanup(users, [])
  await closeDb()
})

async function open(asUserId: string, otherUserId: string) {
  const { email } = await db.user.findUniqueOrThrow({ where: { id: asUserId }, select: { email: true } })
  const res = await conversations.POST(
    new NextRequest("http://localhost/api/mobile/conversations", {
      method: "POST",
      headers: { authorization: `Bearer ${signAccessToken(asUserId, email)}`, "content-type": "application/json" },
      body: JSON.stringify({ otherUserId }),
    })
  )
  return { status: res.status, body: await res.json() }
}

/** Two people who were allowed to talk, and did, until one of them left. */
async function closedPair(label: string) {
  const a = await makeUser(testId(`${label}-a`))
  const b = await makeUser(testId(`${label}-b`))
  users.push(a, b)
  await db.message_requests.create({
    data: { sender_id: a, recipient_id: b, status: "accepted", responded_at: new Date() },
  })
  const { id } = await openConversation(a, b)
  await db.private_conversations.update({
    where: { id },
    data: { closed_at: new Date(), closed_by: b, closed_reason: "unmatch" },
  })
  return { a, b, conversationId: id }
}

it("answers 409 with the respond route's sentence, from either side, and writes nothing", async () => {
  const { a, b } = await closedPair("ccp")

  for (const [me, them] of [[a, b], [b, a]]) {
    const r = await open(me, them)
    expect(r.status).toBe(409)
    expect(r.body.error).toBe("This conversation was closed and cannot be reopened")
  }

  const rows = await db.private_conversations.findMany({
    where: { OR: [{ user1_id: a }, { user2_id: a }] },
    select: { closed_at: true },
  })
  expect(rows).toHaveLength(1)
  expect(rows[0].closed_at).not.toBeNull()
})

it("still opens a live pair", async () => {
  const a = await makeUser(testId("ccp-live-a"))
  const b = await makeUser(testId("ccp-live-b"))
  users.push(a, b)
  await db.message_requests.create({
    data: { sender_id: a, recipient_id: b, status: "accepted", responded_at: new Date() },
  })

  const r = await open(a, b)
  expect(r.status).toBe(200)
  expect(r.body.data.id).toBeTruthy()
})
