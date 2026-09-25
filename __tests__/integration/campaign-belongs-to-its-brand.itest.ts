/*
 * A campaign belongs to its brand, not to whoever else sponsors the event
 * (SCRUM-319, found in the X01 sweep SCRUM-279).
 *
 * The edit and attach doors asked `resolveSponsorGrant(actor, eventId)` —
 * "does some org of mine hold an approved placement at this event" — and then
 * changed whichever campaign id they were given at that event. Up to three
 * brands can be placed at one event, and every ad in the room carries its
 * campaign id in `metadata.sponsored_message_id`. So brand A could pause,
 * rewrite or re-art brand B's live campaign. The create door already bound the
 * brand to the grant; these two never did. Real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("@/lib/tigris", () => ({
  ...jest.requireActual("@/lib/tigris"),
  headObject: jest.fn().mockResolvedValue({ bytes: 1024, contentType: "image/png", versionId: "v1", checksumSha256: "sum" }),
  pinnedUrl: (key: string) => `https://cdn.invalid/${key}`,
}))
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"
/* eslint-disable @typescript-eslint/no-require-imports */
const campaignRoute = require("@/app/api/events/[id]/sponsored-messages/[msgId]/route") as typeof import("@/app/api/events/[id]/sponsored-messages/[msgId]/route")
const { attachCreativeMedia } = require("@/lib/upload-grant-actions") as typeof import("@/lib/upload-grant-actions")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
let eventId = ""
let campaignB = ""
let sponsorA = ""
let sponsorB = ""

/** An organisation that may sponsor, its brand, a member, and an approved placement at the event. */
async function brand(label: string, host: string) {
  const member = await makeUser(testId(`cb-${label}`))
  await db.user.update({ where: { id: member }, data: { role: "sponsor" } })
  users.push(member)
  const org = await db.organisations.create({ data: { kind: "company", display_name: testId(`cb-${label}-org`), status: "verified", may_sponsor: true } })
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: member, role: "owner" } })
  const name = testId(`cb-${label}-brand`)
  const sponsor = await db.sponsors.create({ data: { name, name_key: name.toLowerCase(), org_id: org.id } })
  await db.event_sponsors.create({ data: { event_id: eventId, sponsor_id: sponsor.id, status: "approved", created_by: host } })
  return { member, orgId: org.id, sponsorId: sponsor.id }
}

const patch = (body: object) =>
  campaignRoute.PATCH(
    new Request(`http://localhost/api/events/${eventId}/sponsored-messages/${campaignB}`, { method: "PATCH", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: eventId, msgId: campaignB }) }
  )

const campaign = () =>
  db.event_sponsored_messages.findUniqueOrThrow({
    where: { id: campaignB },
    select: { content: true, is_active: true, moderation_status: true, interval_minutes: true },
  })

const LIVE = { content: "B's words", is_active: true, moderation_status: "approved", interval_minutes: 30 }

beforeAll(async () => {
  const host = await makeUser(testId("cb-host"), "organizer")
  users.push(host)
  eventId = await makeEvent(host)
  events.push(eventId)
  const a = await brand("a", host)
  const b = await brand("b", host)
  sponsorA = a.member
  sponsorB = b.member
  campaignB = (
    await db.event_sponsored_messages.create({
      data: { event_id: eventId, sponsor_id: b.sponsorId, ...LIVE, moderation_status: "approved" },
      select: { id: true },
    })
  ).id
  await db.upload_grants.create({
    data: { user_id: a.member, org_id: a.orgId, key: testId("cb-a-key"), content_type: "image/png", max_bytes: 5_000_000, expires_at: new Date(Date.now() + 3_600_000) },
  })
})

afterAll(async () => {
  await db.sponsored_creatives.deleteMany({ where: { message_id: campaignB } })
  await db.event_sponsored_messages.deleteMany({ where: { event_id: { in: events } } })
  await db.event_sponsors.deleteMany({ where: { event_id: { in: events } } })
  await db.upload_grants.deleteMany({ where: { org_id: { in: orgs } } })
  await db.sponsors.deleteMany({ where: { org_id: { in: orgs } } })
  await db.audit_logs.deleteMany({ where: { user_id: { in: users } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, events)
  await closeDb()
})

describe("another brand placed at the same event", () => {
  beforeEach(() => mockGetAuth.mockResolvedValue({ user: { id: sponsorA, role: "sponsor" } }))

  it("cannot pause the campaign or rewrite its words", async () => {
    expect((await patch({ is_active: false })).status).toBe(403)
    expect((await patch({ content: "A's words now" })).status).toBe(403)
    expect(await campaign()).toEqual(LIVE)
  })

  it("cannot put its own upload on the campaign", async () => {
    const key = (await db.upload_grants.findFirstOrThrow({ where: { user_id: sponsorA }, select: { key: true } })).key
    await expect(attachCreativeMedia(campaignB, key)).rejects.toThrow("Forbidden")
    expect(await db.sponsored_creatives.count({ where: { message_id: campaignB } })).toBe(0)
    expect(await campaign()).toEqual(LIVE)
  })
})

it("the brand's own member still can", async () => {
  mockGetAuth.mockResolvedValue({ user: { id: sponsorB, role: "sponsor" } })
  expect((await patch({ interval_minutes: 60 })).status).toBe(200)
  expect((await campaign()).interval_minutes).toBe(60)
})
