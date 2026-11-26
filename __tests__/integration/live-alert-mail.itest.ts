/*
 * The host's critical live alert mail (SCRUM-1286) on a db:migrate database: the issue sweep through real Postgres,
 * with Resend's fetch captured. A room pushed over its stated capacity opens the critical issue; the organization's
 * owners and admins are mailed once; a bump, a flapping room and an event with no organization mail nobody. Every
 * read counts this suite's own rows only (its events, its addresses): the itest database is shared.
 */
import { randomUUID } from "crypto"

import { recordIssuesFor } from "@/lib/event-issues"

import { cleanup, closeDb, db, makeUser, occurrenceOf, putInRoom, testId } from "./helpers"

const MIN = 60_000
const users: { id: string; email: string }[] = []
const guestIds: string[] = []
const orgs: string[] = []
const events: string[] = []
const mails: { to: string; subject: string; text: string; headers?: Record<string, string>; tags: { name: string; value: string }[] }[] = []
let realFetch: typeof fetch

async function person(label: string) {
  const id = testId(label)
  const email = `itest-la-${label}-${randomUUID().slice(0, 8)}@resend.dev`
  await db.user.create({ data: { id, email, name: `Test ${label}`, role: "organizer" } })
  const user = { id, email }
  users.push(user)
  return user
}

/** A live night of `orgId` (or of nobody) whose room of `capacity` holds `guests` checked-in guests. */
async function liveNight(orgId: string | null, capacity = 2, guests = 4) {
  const creator = await person("creator")
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("la-evt"),
      title: "Friday at Toit",
      description: "integration fixture",
      start_time: new Date(now - 60 * MIN),
      end_time: new Date(now + 3 * 60 * MIN),
      timezone: "Asia/Kolkata",
      status: "published",
      max_capacity: capacity,
      organizer_id: creator.id,
      organizer_org_id: orgId,
    },
  })
  events.push(event.id)
  await db.event_occurrences.create({
    data: { event_id: event.id, occurs_on: new Date(event.start_time.toISOString().slice(0, 10)), start_time: event.start_time, end_time: event.end_time },
  })
  const occurrenceId = await occurrenceOf(event.id)
  for (let i = 0; i < guests; i++) {
    const u = await makeUser(testId(`la-g${i}`))
    guestIds.push(u)
    await putInRoom({ eventId: event.id, occurrenceId, userId: u })
  }
  return event.id
}

const capacity = (eventId: string, max: number) => db.events.update({ where: { id: eventId }, data: { max_capacity: max } })
const mailedTo = (who: { email: string }[]) => mails.filter((m) => who.some((u) => u.email === m.to)).map((m) => m.to).sort()
const aboutEvent = (eventId: string) => mails.filter((m) => m.text.includes(`/dashboard/events/${eventId}?tab=live`))
/**
 * The mail is fire and forget: wait for it to land, then a second more so a mail that should not exist has time to
 * (four local round trips take milliseconds; the unit suite proves the "none" cases deterministically).
 */
async function settle(count = 0, who: { email: string }[] = []) {
  for (let i = 0; i < 100 && mailedTo(who).length < count; i++) await new Promise((r) => setTimeout(r, 50))
  await new Promise((r) => setTimeout(r, 1000))
}

beforeAll(() => {
  process.env.RESEND_API_KEY = "re_itest"
  process.env.EMAIL_FROM = "Blend'n <hello@blendn.app>"
  realFetch = global.fetch
  global.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as (typeof mails)[number] & { to: string[] }
    mails.push({ to: body.to[0], subject: body.subject, text: body.text, headers: body.headers, tags: body.tags })
    return new Response(JSON.stringify({ id: randomUUID() }), { status: 200 })
  }) as unknown as typeof fetch
})

afterAll(async () => {
  global.fetch = realFetch
  await db.email_suppressions.deleteMany({ where: { email: { in: users.map((u) => u.email) } } })
  await db.event_issues.deleteMany({ where: { event_id: { in: events } } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await cleanup([], events)
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup([...users.map((u) => u.id), ...guestIds], [])
  await closeDb()
})

describe("a room over its stated capacity", () => {
  it("mails each owner and admin once, an unsubscribed owner too; a bounced owner and staff are not; the bump mails nobody", async () => {
    const [owner, unsubscribed, bounced, admin, staff] = [
      await person("owner"),
      await person("unsub"),
      await person("bounced"),
      await person("admin"),
      await person("staff"),
    ]
    const o = await db.organisations.create({ data: { kind: "company", display_name: testId("la-org"), status: "verified" } })
    orgs.push(o.id)
    for (const [u, role] of [[owner, "owner"], [unsubscribed, "owner"], [bounced, "owner"], [admin, "admin"], [staff, "staff"]] as const) {
      await db.organisation_members.create({ data: { org_id: o.id, user_id: u.id, role } })
    }
    await db.email_suppressions.createMany({
      data: [
        { email: unsubscribed.email, reason: "unsubscribe" },
        { email: bounced.email, reason: "bounce" },
      ],
    })
    const everyone = [owner, unsubscribed, bounced, admin, staff]
    const eventId = await liveNight(o.id)

    const now = new Date()
    expect((await recordIssuesFor(eventId, now)).opened).toBe(1)
    await settle(3, everyone)
    expect(mailedTo(everyone)).toEqual([admin.email, owner.email, unsubscribed.email].sort())
    const mail = mails.find((m) => m.to === owner.email)!
    expect(mail.subject).toBe("Friday at Toit: Over stated capacity")
    expect(mail.text).toContain("4 guests against capacity 2 — 2 over.")
    expect(mail.text).toContain(`/dashboard/events/${eventId}?tab=live`)
    expect(mail.tags).toEqual([{ name: "kind", value: "live_alert" }])
    expect(mail.headers?.["List-Unsubscribe"]).toBeUndefined()

    const rows = await db.event_issues.findMany({ where: { event_id: eventId }, select: { kind: true, severity: true, opened_at: true, mailed_at: true } })
    expect(rows).toEqual([{ kind: "over_capacity", severity: "critical", opened_at: now, mailed_at: now }])

    // Still over a minute later: bumped, not reopened, and nobody mailed again.
    expect((await recordIssuesFor(eventId, new Date(now.getTime() + MIN))).stillOpen).toBe(1)
    await settle()
    expect(mailedTo(everyone)).toHaveLength(3)
  })

  it("flapping over the line opens a new row each time and mails once; after 30 quiet minutes it mails again", async () => {
    const owner = await person("flap-owner")
    const o = await db.organisations.create({ data: { kind: "company", display_name: testId("la-org"), status: "verified" } })
    orgs.push(o.id)
    await db.organisation_members.create({ data: { org_id: o.id, user_id: owner.id, role: "owner" } })
    const eventId = await liveNight(o.id)
    const t = Date.now()
    const at = (m: number) => new Date(t + m * MIN)

    await recordIssuesFor(eventId, at(0))
    await capacity(eventId, 50)
    await recordIssuesFor(eventId, at(1))
    await capacity(eventId, 2)
    await recordIssuesFor(eventId, at(2))
    await capacity(eventId, 50)
    await recordIssuesFor(eventId, at(3))
    await settle(1, [owner])
    expect(await db.event_issues.count({ where: { event_id: eventId, kind: "over_capacity" } })).toBe(2)
    expect(mailedTo([owner])).toHaveLength(1)
    // Only the mailed opening carries the claim; the window counts from it.
    expect(await db.event_issues.count({ where: { event_id: eventId, mailed_at: { not: null } } })).toBe(1)

    await capacity(eventId, 2)
    await recordIssuesFor(eventId, at(40))
    await settle(2, [owner])
    expect(await db.event_issues.count({ where: { event_id: eventId, kind: "over_capacity" } })).toBe(3)
    expect(mailedTo([owner])).toHaveLength(2)
    expect(await db.event_issues.count({ where: { event_id: eventId, mailed_at: { not: null } } })).toBe(2)
  })

  it("an event with no organization records the issue and mails nobody", async () => {
    const eventId = await liveNight(null)
    expect((await recordIssuesFor(eventId)).opened).toBe(1)
    await settle()
    expect(aboutEvent(eventId)).toHaveLength(0)
    expect(await db.event_issues.count({ where: { event_id: eventId, kind: "over_capacity", severity: "critical" } })).toBe(1)
  })
})
