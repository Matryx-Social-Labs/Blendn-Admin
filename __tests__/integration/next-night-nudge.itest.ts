/*
 * The "list your next" nudge (SCRUM-1284, launch gate 14) on a db:migrate database: the sweep through real Postgres
 * with Resend's fetch captured. Which nights count, what counts as coming up, the 30-day claim on
 * organisations.next_event_nudged_at. Every count reads this suite's own rows only (its organizations, its addresses):
 * the itest database is shared.
 */
import { randomUUID } from "crypto"

import { sendNextNightNudges } from "@/lib/next-night-nudge"

import { cleanup, closeDb, db, testId } from "./helpers"

process.env.NEXTAUTH_SECRET ??= "itest-next-night-secret-of-forty-chars!!!"

const DAY = 86_400_000
/** 10:00 IST Fri 2032-06-18, a week after a night that ended 02:00 IST Fri 2032-06-11: dates no other suite uses. */
const NOW = new Date("2032-06-18T04:30:00Z")
const LAST_NIGHT = new Date("2032-06-10T20:30:00Z")

const users: { id: string; email: string }[] = []
const orgs: string[] = []
const events: string[] = []
const mails: { to: string; subject: string; text: string; tags: { name: string; value: string }[] }[] = []
let realFetch: typeof fetch
/** Who created the fixture nights (`organizer_id`); never a member, so never a recipient. */
let creator: { id: string; email: string }

async function person(label: string) {
  const id = testId(label)
  const email = `itest-nn-${label}-${randomUUID().slice(0, 8)}@resend.dev`
  await db.user.create({ data: { id, email, name: `Test ${label}`, role: "organizer" } })
  const user = { id, email }
  users.push(user)
  return user
}

async function org(members: [{ id: string }, "owner" | "admin" | "staff"][], nudgedAt: Date | null = null) {
  const o = await db.organisations.create({
    data: { kind: "company", display_name: testId("nn-org"), status: "verified", next_event_nudged_at: nudgedAt },
  })
  orgs.push(o.id)
  for (const [user, role] of members) await db.organisation_members.create({ data: { org_id: o.id, user_id: user.id, role } })
  return o.id
}

type Status = "published" | "completed" | "cancelled" | "draft"
async function night(orgId: string, o: { title?: string; endedAt?: Date; startsAt?: Date; status?: Status; came?: number; timezone?: string } = {}) {
  const start = o.startsAt ?? new Date((o.endedAt ?? LAST_NIGHT).getTime() - 5 * 3600_000)
  const end = o.endedAt ?? new Date(start.getTime() + 5 * 3600_000)
  const event = await db.events.create({
    data: {
      slug: testId("nn-evt"),
      title: o.title ?? "Last night",
      description: "integration fixture",
      start_time: start,
      end_time: end,
      timezone: o.timezone ?? "Asia/Kolkata",
      status: o.status ?? "published",
      organizer_id: creator.id,
      organizer_org_id: orgId,
    },
  })
  events.push(event.id)
  const occurrence = await db.event_occurrences.create({
    data: { event_id: event.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: end },
  })
  for (let i = 0; i < (o.came ?? 6); i++) {
    const guest = await person(`guest${i}`)
    await db.event_check_ins.create({
      data: { event_id: event.id, occurrence_id: occurrence.id, user_id: guest.id, kind: "attendee", status: "checked_out", check_in_time: start },
    })
  }
  return event.id
}

const mailedTo = (who: { email: string }[]) => mails.filter((m) => who.some((u) => u.email === m.to)).map((m) => m.to).sort()
const nudgedAt = async (orgId: string) =>
  (await db.organisations.findUnique({ where: { id: orgId }, select: { next_event_nudged_at: true } }))?.next_event_nudged_at ?? null

beforeAll(async () => {
  creator = await person("creator")
  process.env.RESEND_API_KEY = "re_itest"
  process.env.EMAIL_FROM = "Blend'n <hello@blendn.app>"
  realFetch = global.fetch
  global.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as (typeof mails)[number] & { to: string[] }
    mails.push({ to: body.to[0], subject: body.subject, text: body.text, tags: body.tags })
    return new Response(JSON.stringify({ id: randomUUID() }), { status: 200 })
  }) as unknown as typeof fetch
})

afterAll(async () => {
  global.fetch = realFetch
  await db.email_suppressions.deleteMany({ where: { email: { in: users.map((u) => u.email) } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await cleanup([], events)
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users.map((u) => u.id), [])
  await closeDb()
})

describe("the sweep", () => {
  it("nothing on day 6 or at 09:59 on day 7; one mail to each owner and admin at 10:00; none on day 8", async () => {
    const [owner1, owner2, admin, staff] = [await person("owner1"), await person("owner2"), await person("admin"), await person("staff")]
    const orgId = await org([[owner1, "owner"], [owner2, "owner"], [admin, "admin"], [staff, "staff"]])
    await night(orgId, { title: "Friday at Toit" })
    const everyone = [owner1, owner2, admin, staff]

    await sendNextNightNudges(new Date(NOW.getTime() - DAY))
    await sendNextNightNudges(new Date(NOW.getTime() - 60_000))
    expect(mailedTo(everyone)).toEqual([])
    expect(await nudgedAt(orgId)).toBeNull()

    await sendNextNightNudges(NOW)
    expect(mailedTo(everyone)).toEqual([admin.email, owner1.email, owner2.email].sort())
    expect(await nudgedAt(orgId)).toEqual(NOW)
    const mail = mails.find((m) => m.to === owner1.email)!
    expect(mail.subject).toBe("Friday at Toit: what’s next?")
    expect(mail.text).toContain("6 people checked in on Blend’n at Friday at Toit last week. Nothing is listed after it yet.")
    expect(mail.tags).toEqual([{ name: "kind", value: "next_night" }])

    await sendNextNightNudges(new Date(NOW.getTime() + 5 * 60_000))
    await sendNextNightNudges(new Date(NOW.getTime() + DAY))
    expect(mailedTo(everyone)).toHaveLength(3)
  })

  it("three passes at once (two replicas, or a slow pass and the next) mail each person once", async () => {
    const [a, b] = [await person("race-a"), await person("race-b")]
    const orgId = await org([[a, "owner"], [b, "admin"]])
    await night(orgId)
    await Promise.all([sendNextNightNudges(NOW), sendNextNightNudges(NOW), sendNextNightNudges(NOW)])
    expect(mailedTo([a, b])).toEqual([a.email, b.email].sort())
  })

  it("a Toronto night across the clock change: 10:00 EST a week on", async () => {
    const owner = await person("toronto")
    const orgId = await org([[owner, "owner"]])
    // Ends 02:00 EDT Sun 2032-10-31; clocks go back at 02:00 Sun 2032-11-07, so 10:00 that day is 15:00Z.
    await night(orgId, { endedAt: new Date("2032-10-31T06:00:00Z"), timezone: "America/Toronto" })
    await sendNextNightNudges(new Date("2032-11-07T14:59:00Z"))
    expect(mailedTo([owner])).toEqual([])
    await sendNextNightNudges(new Date("2032-11-07T15:00:00Z"))
    expect(mailedTo([owner])).toEqual([owner.email])
  })
})

describe("what counts as coming up, and as the last night", () => {
  it("an org with a published night ahead, or one running now, gets nothing and is not claimed", async () => {
    const [ahead, running] = [await person("ahead"), await person("running")]
    const aheadOrg = await org([[ahead, "owner"]])
    await night(aheadOrg)
    await night(aheadOrg, { startsAt: new Date(NOW.getTime() + 3 * DAY), came: 0 })
    const runningOrg = await org([[running, "owner"]])
    await night(runningOrg)
    await night(runningOrg, { startsAt: new Date(NOW.getTime() - 3600_000), came: 0 })

    await sendNextNightNudges(NOW)
    expect(mailedTo([ahead, running])).toEqual([])
    expect(await nudgedAt(aheadOrg)).toBeNull()
    expect(await nudgedAt(runningOrg)).toBeNull()
  })

  it("a draft or cancelled night ahead is not listed, so the host is nudged", async () => {
    const owner = await person("draft")
    const orgId = await org([[owner, "owner"]])
    await night(orgId)
    await night(orgId, { startsAt: new Date(NOW.getTime() + 3 * DAY), status: "draft", came: 0 })
    await night(orgId, { startsAt: new Date(NOW.getTime() + 4 * DAY), status: "cancelled", came: 0 })
    await sendNextNightNudges(NOW)
    expect(mailedTo([owner])).toEqual([owner.email])
  })

  it("only the org's latest ended night counts: nothing a week after an earlier one, then one a week after the latest", async () => {
    const owner = await person("several")
    const orgId = await org([[owner, "owner"]])
    await night(orgId, { title: "First night" })
    await night(orgId, { title: "Second night", endedAt: new Date(LAST_NIGHT.getTime() + 3 * DAY) })

    await sendNextNightNudges(NOW)
    expect(mailedTo([owner])).toEqual([])

    await sendNextNightNudges(new Date(NOW.getTime() + 3 * DAY))
    expect(mails.filter((m) => m.to === owner.email).map((m) => m.subject)).toEqual(["Second night: what’s next?"])
  })

  it("a cancelled last night is not a night held: the one before it is a week back only if it is the latest held", async () => {
    const owner = await person("cancelled-last")
    const orgId = await org([[owner, "owner"]])
    await night(orgId, { title: "Held night" })
    // Cancelled, ended after the held one: not held, so the held night is still the last.
    await night(orgId, { title: "Called off", endedAt: new Date(LAST_NIGHT.getTime() + DAY), status: "cancelled", came: 0 })
    await sendNextNightNudges(NOW)
    expect(mails.filter((m) => m.to === owner.email).map((m) => m.subject)).toEqual(["Held night: what’s next?"])
  })
})

describe("the 30-day claim", () => {
  it("nudged 29 days ago: nothing; 30 days ago: one again", async () => {
    const [recent, month] = [await person("recent"), await person("month")]
    const recentOrg = await org([[recent, "owner"]], new Date(NOW.getTime() - 29 * DAY))
    await night(recentOrg)
    const monthOrg = await org([[month, "owner"]], new Date(NOW.getTime() - 30 * DAY))
    await night(monthOrg)

    await sendNextNightNudges(NOW)
    expect(mailedTo([recent])).toEqual([])
    expect(await nudgedAt(recentOrg)).toEqual(new Date(NOW.getTime() - 29 * DAY))
    expect(mailedTo([month])).toEqual([month.email])
    expect(await nudgedAt(monthOrg)).toEqual(NOW)
  })
})

describe("who", () => {
  it("an unsubscribed owner and a bounced owner are skipped; the third owner is mailed", async () => {
    const [left, bounced, kept] = [await person("unsub"), await person("bounced"), await person("kept")]
    const orgId = await org([[left, "owner"], [bounced, "owner"], [kept, "owner"]])
    await db.email_suppressions.createMany({ data: [{ email: left.email, reason: "unsubscribe" }, { email: bounced.email, reason: "bounce" }] })
    await night(orgId)
    await sendNextNightNudges(NOW)
    expect(mailedTo([left, bounced, kept])).toEqual([kept.email])
  })

  it("a deleted owner is not mailed; the other owner is", async () => {
    const [gone, kept] = [await person("deleted"), await person("kept2")]
    const orgId = await org([[gone, "owner"], [kept, "owner"]])
    await db.user.update({ where: { id: gone.id }, data: { deletedAt: new Date() } })
    await night(orgId)
    await sendNextNightNudges(NOW)
    expect(mailedTo([gone, kept])).toEqual([kept.email])
  })

  it("a suspended organization is never nudged or claimed", async () => {
    const owner = await person("suspended-org")
    const orgId = await org([[owner, "owner"]])
    await db.organisations.update({ where: { id: orgId }, data: { status: "suspended" } })
    await night(orgId)
    await sendNextNightNudges(NOW)
    expect(mailedTo([owner])).toEqual([])
    expect(await nudgedAt(orgId)).toBeNull()
  })

  it("a night nobody checked in at quotes no number", async () => {
    const owner = await person("zero")
    const orgId = await org([[owner, "owner"]])
    await night(orgId, { title: "Quiet night", came: 0 })
    await sendNextNightNudges(NOW)
    const mail = mails.find((m) => m.to === owner.email)!
    expect(mail.text).toContain("It’s a week since Quiet night, and nothing is listed after it yet.")
    expect(mail.text).not.toMatch(/people|checked in/)
  })
})
