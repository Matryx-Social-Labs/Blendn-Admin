import { NextRequest } from "next/server"

/*
 * A closed room tells its members its kind and name (RC8): still 404
 * `NOT_FOUND`, with `reasonCode: "ROOM_CLOSED"`. Somebody with no membership
 * row gets the bare 404, so a guessed id never learns a name.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"
/* eslint-disable @typescript-eslint/no-require-imports */
const messages = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
const ROOM_NAME = "Friday Rooftop"
let eventId = ""
let groupId = ""
const tokens: Record<"member" | "stranger", string> = { member: "", stranger: "" }

afterAll(async () => {
  await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

const read = async (who: "member" | "stranger") => {
  const res = await messages.GET(
    new NextRequest(`http://localhost/api/mobile/chat/groups/${groupId}/messages`, { headers: { authorization: `Bearer ${tokens[who]}` } }),
    { params: Promise.resolve({ chatGroupId: groupId }) }
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

beforeAll(async () => {
  const host = await makeUser(testId("crm-host"), "organizer")
  const member = await makeUser(testId("crm-member"))
  const stranger = await makeUser(testId("crm-stranger"))
  users.push(host, member, stranger)
  eventId = await makeEvent(host)
  events.push(eventId)
  groupId = (await db.chat_groups.create({ data: { event_id: eventId, name: ROOM_NAME, status: "active" }, select: { id: true } })).id
  await db.chat_group_members.create({ data: { chat_group_id: groupId, user_id: member, status: "active", anonymous_name: testId("Heron") } })
  for (const [who, id] of [["member", member], ["stranger", stranger]] as const) {
    const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
    tokens[who] = await signAccessToken(id, email)
  }
})

it("serves an open room as before", async () => {
  const { status, body } = await read("member")
  expect(status).toBe(200)
  expect(body).not.toHaveProperty("reasonCode")
  expect(body).not.toHaveProperty("roomName")
})

describe("once the room is closed", () => {
  beforeAll(async () => {
    await db.events.update({ where: { id: eventId }, data: { deleted_at: new Date() } })
  })

  it("tells a member the kind and the name, and keeps 404 NOT_FOUND", async () => {
    const { status, body } = await read("member")
    expect(status).toBe(404)
    expect(body).toMatchObject({
      success: false,
      errorCode: "NOT_FOUND",
      reasonCode: "ROOM_CLOSED",
      roomKind: "event",
      roomName: ROOM_NAME,
    })
  })

  it("gives somebody with no membership row the bare 404", async () => {
    const { status, body } = await read("stranger")
    expect(status).toBe(404)
    expect(body.errorCode).toBe("NOT_FOUND")
    expect(JSON.stringify(body)).not.toContain(ROOM_NAME)
    expect(body).not.toHaveProperty("reasonCode")
    expect(body).not.toHaveProperty("roomKind")
  })
})
