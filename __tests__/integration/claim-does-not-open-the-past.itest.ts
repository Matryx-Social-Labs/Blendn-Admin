let session: { user: { id: string; role: string } } | null = null
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))

import { NextRequest } from "next/server"
import { actorFor } from "@/lib/org-membership"
import { eventPermissions, eventPermissionSelect } from "@/lib/rbac"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const chatRoute = require("@/app/api/events/[id]/chat/messages/route") as
  typeof import("@/app/api/events/[id]/chat/messages/route")

/*
 * SCRUM-355, owner's ruling 1 (2026-09-27): an approved venue claim does not
 * open the venue's past. `canOperate` — the chat, moderation, the attendee
 * list — was granted over every event ever linked to the venue. With
 * organisers adding unclaimed venues (SCRUM-352), a claim would have reached
 * back through that whole history. The past is for aggregate insights
 * (SCRUM-356), never people.
 *
 * Against the real select, from Postgres: a caller that loads the event
 * without `start_time` or `venue.claimed_at` no longer typechecks, and this
 * proves the shared fragment carries them.
 */
const users: string[] = []
const orgs: string[] = []
const events: string[] = []
const venues: string[] = []
const DAY = 86_400_000

afterAll(async () => {
  await db.events.updateMany({ where: { id: { in: events } }, data: { venue_id: null } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await cleanup(users, events)
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

async function world() {
  const host = await makeUser(testId("cdop-host"), "organizer")
  const owner = await makeUser(testId("cdop-owner"), "organizer")
  users.push(host, owner)
  await db.user.update({ where: { id: owner }, data: { role: "venue_owner" } })
  const org = await db.organisations.create({
    data: { kind: "company", display_name: testId("cdop-venue-org"), status: "verified" },
  })
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: owner, role: "owner" } })

  const claimedAt = new Date(Date.now() - 2 * DAY)
  const venue = await db.venues.create({
    data: { name: testId("cdop-venue"), latitude: 12.9, longitude: 77.5, owner_org_id: org.id, claimed_at: claimedAt },
    select: { id: true },
  })
  venues.push(venue.id)

  const at = async (start: Date) => {
    const id = await makeEvent(host)
    events.push(id)
    await db.events.update({
      where: { id },
      data: { venue_id: venue.id, start_time: start, end_time: new Date(start.getTime() + 3 * 3_600_000) },
    })
    return id
  }
  return {
    owner,
    before: await at(new Date(claimedAt.getTime() - 5 * DAY)),
    after: await at(new Date(Date.now() + 5 * DAY)),
  }
}

describe("a venue owner operates only events after the claim (SCRUM-355)", () => {
  it("resolves from the real select: the event before the claim is closed, the one after is open", async () => {
    const w = await world()
    const actor = await actorFor({ id: w.owner, role: "venue_owner" })
    const load = (id: string) => db.events.findUniqueOrThrow({ where: { id }, select: eventPermissionSelect })

    expect(eventPermissions(actor, await load(w.before)).canOperate).toBe(false)
    expect(eventPermissions(actor, await load(w.after)).canOperate).toBe(true)
  })

  it("the room's messages refuse the owner for the event before the claim", async () => {
    const w = await world()
    session = { user: { id: w.owner, role: "venue_owner" } }
    const get = (id: string) =>
      chatRoute.GET(new NextRequest(`http://localhost/api/events/${id}/chat/messages`), {
        params: Promise.resolve({ id }),
      })

    expect((await get(w.before)).status).toBe(403)
    expect((await get(w.after)).status).not.toBe(403)
  })
})
