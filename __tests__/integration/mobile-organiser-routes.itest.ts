import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/push-notifications", () => ({
  ...jest.requireActual("@/lib/push-notifications"),
  notifyAnnouncement: jest.fn().mockResolvedValue({ sent: 0, failed: 0 }),
  notifyEventUpdate: jest.fn().mockResolvedValue({ sent: 0, failed: 0 }),
}))

import { signAccessToken } from "@/lib/mobile-auth"

import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/*
 * The app's organiser tray — Announce / Edit / Delete on the event screen —
 * calls three routes on the attendee API. The SCRUM-166 review kept them
 * (they are a shipped surface) on the condition that their organisation-shaped
 * rules are held by a test: a colleague at the organising org who did not
 * create the row gets in, a member who left does not, a stranger does not.
 * Real routes, real tokens, real rows.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventRoute = require("@/app/api/mobile/events/[eventId]/route") as typeof import("@/app/api/mobile/events/[eventId]/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const announceRoute = require("@/app/api/mobile/events/[eventId]/announce/route") as typeof import("@/app/api/mobile/events/[eventId]/announce/route")

const users: string[] = []
const events: string[] = []
const orgs: string[] = []

afterAll(async () => {
  await cleanup(users, events)
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

async function host(label: string) {
  const id = await makeUser(label, "organizer")
  users.push(id)
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, email) }
}

const req = (url: string, token: string, method: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
const params = (eventId: string) => ({ params: Promise.resolve({ eventId }) })

it("a colleague may edit, announce and delete; an ex-member and a stranger may not", async () => {
  const creator = await host("mor-creator")
  const colleague = await host("mor-colleague")
  const left = await host("mor-left")
  const stranger = await host("mor-stranger")
  const org = await db.organisations.create({ data: { display_name: testId("Org"), status: "verified" } })
  orgs.push(org.id)
  await db.organisation_members.createMany({
    data: [
      { org_id: org.id, user_id: creator.id, role: "owner" },
      { org_id: org.id, user_id: colleague.id, role: "admin" },
    ],
  })
  const eventId = await makeEvent(creator.id)
  events.push(eventId)
  await db.events.update({ where: { id: eventId }, data: { organizer_org_id: org.id } })
  await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" } })

  const patch = (t: string) =>
    eventRoute.PATCH(req(`/api/mobile/events/${eventId}`, t, "PATCH", { description: "edited from the phone" }), params(eventId))
  const announce = (t: string) =>
    announceRoute.POST(req(`/api/mobile/events/${eventId}/announce`, t, "POST", { content: "Doors at nine." }), params(eventId))

  // The colleague never created the row and gets everything: organisation-shaped.
  expect((await patch(colleague.token)).status).toBe(200)
  expect((await db.events.findUniqueOrThrow({ where: { id: eventId } })).description).toBe("edited from the phone")
  expect((await announce(colleague.token)).status).toBe(200)
  expect(await db.chat_messages.count({ where: { chat_group: { event_id: eventId }, type: "announcement" } })).toBe(1)

  // A stranger is refused, and writes nothing.
  expect((await patch(stranger.token)).status).toBe(403)
  expect((await announce(stranger.token)).status).toBe(403)

  // A member who left is a stranger from that moment.
  await db.organisation_members.create({ data: { org_id: org.id, user_id: left.id, role: "admin" } })
  expect((await patch(left.token)).status).toBe(200)
  await db.organisation_members.deleteMany({ where: { org_id: org.id, user_id: left.id } })
  expect((await patch(left.token)).status).toBe(403)
  expect((await announce(left.token)).status).toBe(403)

  // Delete: the stranger cannot, the colleague can, and the row is soft-deleted.
  expect((await eventRoute.DELETE(req(`/api/mobile/events/${eventId}`, stranger.token, "DELETE"), params(eventId))).status).toBe(403)
  expect((await eventRoute.DELETE(req(`/api/mobile/events/${eventId}`, colleague.token, "DELETE"), params(eventId))).status).toBe(200)
  expect((await db.events.findUniqueOrThrow({ where: { id: eventId } })).deleted_at).not.toBeNull()
})
