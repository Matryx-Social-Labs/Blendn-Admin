import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
// The real module, watched: what the sender reads is the bell row; what their lock screen shows is the push.
jest.mock("@/lib/push-notifications", () => {
  const actual = jest.requireActual<typeof import("@/lib/push-notifications")>("@/lib/push-notifications")
  return { ...actual, sendPushNotification: jest.fn(actual.sendPushNotification) }
})

import { signAccessToken } from "@/lib/mobile-auth"
import { sendPushNotification } from "@/lib/push-notifications"

import { cleanup, closeDb, db, makeUser } from "./helpers"

/**
 * SCRUM-621: a decline tells the sender nothing. The owner's ruling of 2026-10-09
 * (N1) and the product's no-declined-state rule: no push, and no bell row either
 * (`recordNotification` writes the row for every type that is not in
 * NOT_IN_THE_BELL, so a push call alone is a notification). Accept keeps its
 * push. The real push module runs, watched: the assertions are on the call to it
 * and on the `notifications` table, which is what the sender would read.
 *
 * Note the bell row alone proves nothing here: on a decline the payload carried
 * `conversationId: undefined`, which Prisma refuses for a JSON column, so
 * `recordNotification` logged a warning and wrote nothing -- by accident, while
 * the push to the sender's devices went out. The call is the thing to pin.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const respond = require("@/app/api/mobile/message-requests/[requestId]/respond/route") as typeof import("@/app/api/mobile/message-requests/[requestId]/respond/route")

const users: string[] = []

afterAll(async () => {
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.message_requests.deleteMany({ where: { OR: [{ sender_id: { in: users } }, { recipient_id: { in: users } }] } })
  await db.private_conversations.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await cleanup(users, [])
  await closeDb()
})

async function pending() {
  const sender = await makeUser("mrd-sender")
  const recipient = await makeUser("mrd-recipient")
  users.push(sender, recipient)
  const request = await db.message_requests.create({ data: { sender_id: sender, recipient_id: recipient, message: "hi there", status: "pending" } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id: recipient }, select: { email: true } })
  return { sender, recipient, requestId: request.id, token: signAccessToken(recipient, email) }
}

const answer = (requestId: string, token: string, action: "accept" | "decline" | "block") =>
  respond.POST(
    new NextRequest(`http://localhost/api/mobile/message-requests/${requestId}/respond`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ action }),
    }),
    { params: Promise.resolve({ requestId }) }
  )

/** The push is fire and forget; give it a moment to write its bell row if it is going to. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400))
const bellFor = (userId: string) => db.notifications.findMany({ where: { user_id: userId, kind: "message_request_response" } })

describe("POST /message-requests/:id/respond", () => {
  it.each(["decline", "block"] as const)("%s writes nothing the sender can read: no bell row, no push", async (action) => {
    const { sender, requestId, token } = await pending()
    ;(sendPushNotification as jest.Mock).mockClear()

    const res = await answer(requestId, token, action)
    await settle()

    expect(res.status).toBe(200)
    expect((await db.message_requests.findUniqueOrThrow({ where: { id: requestId } })).status).toBe(action === "decline" ? "declined" : "blocked")
    expect(sendPushNotification).not.toHaveBeenCalled()
    expect(await bellFor(sender)).toHaveLength(0)
  })

  it("accept still tells the sender, by name", async () => {
    const { sender, requestId, token } = await pending()
    ;(sendPushNotification as jest.Mock).mockClear()

    expect((await answer(requestId, token, "accept")).status).toBe(200)
    await settle()

    expect(sendPushNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: sender, title: expect.stringMatching(/accepted/i) }))
    const rows = await bellFor(sender)
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toMatch(/accepted/i)
  })
})
