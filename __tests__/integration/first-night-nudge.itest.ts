/*
 * The first-night nudge (SCRUM-1342) on a db:migrate database: the sweep through real Postgres, with Resend's fetch
 * captured. Which organizations qualify (an approved organizer application, no event in any status, not suspended,
 * never nudged), and the claim it shares with 04c's nudge on organisations.next_event_nudged_at. Every count reads
 * this suite's own rows only (its addresses): the itest database is shared. Each case has its own fortnight in 2033,
 * dates no other suite uses, so one case's pass never reaches another's organizations.
 */
import { randomUUID } from "crypto"

import { sendFirstNightNudges, sendNextNightNudges } from "@/lib/next-night-nudge"

import { cleanup, closeDb, db, testId } from "./helpers"

process.env.NEXTAUTH_SECRET ??= "itest-first-night-secret-of-forty-chars!!"

const DAY = 86_400_000
/** Approved 08:00 IST Mon 2033-03-07: due 10:00 IST Thu 2033-03-10. Case `k` is the same, `k` fortnights later. */
const approvedAt = (k: number) => new Date(Date.parse("2033-03-07T02:30:00Z") + k * 14 * DAY)
const dueAt = (k: number) => new Date(approvedAt(k).getTime() + 3 * DAY + 2 * 3600_000)

const users: { id: string; email: string }[] = []
const orgs: string[] = []
const requests: string[] = []
const events: string[] = []
const mails: { to: string; subject: string; text: string; tags: { name: string; value: string }[] }[] = []
let realFetch: typeof fetch
let creator: { id: string; email: string }

async function person(label: string) {
  const id = testId(label)
  const email = `itest-fn-${label}-${randomUUID().slice(0, 8)}@resend.dev`
  await db.user.create({ data: { id, email, name: `Test ${label}`, role: "organizer" } })
  const user = { id, email }
  users.push(user)
  return user
}

type Role = "organizer" | "venue_owner" | "sponsor"
/** An organization as an approval leaves it, with the application that made it. */
async function approved(
  k: number,
  members: [{ id: string }, "owner" | "admin" | "staff"][],
  o: { role?: Role; city?: string | null; at?: Date; status?: "verified" | "suspended"; suspendedAt?: Date | null; nudgedAt?: Date | null } = {}
) {
  const org = await db.organisations.create({
    data: {
      kind: "company",
      display_name: testId("fn-org"),
      status: o.status ?? "verified",
      suspended_at: o.suspendedAt ?? null,
      next_event_nudged_at: o.nudgedAt ?? null,
    },
  })
  orgs.push(org.id)
  for (const [user, role] of members) await db.organisation_members.create({ data: { org_id: org.id, user_id: user.id, role } })
  const request = await db.organiser_onboarding_requests.create({
    data: {
      display_name: testId("fn-app"),
      contact_name: "Test Host",
      contact_email: `itest-fn-app-${randomUUID().slice(0, 8)}@resend.dev`,
      requested_role: o.role ?? "organizer",
      city: o.city === undefined ? "Bengaluru" : o.city,
      status: "approved",
      reviewed_at: o.at ?? approvedAt(k),
      org_id: org.id,
    },
  })
  requests.push(request.id)
  return org.id
}

async function event(orgId: string, o: { status: "draft" | "published" | "cancelled"; endedAt: Date; deleted?: boolean }) {
  const e = await db.events.create({
    data: {
      slug: testId("fn-evt"),
      title: "A night",
      description: "integration fixture",
      start_time: new Date(o.endedAt.getTime() - 5 * 3600_000),
      end_time: o.endedAt,
      timezone: "Asia/Kolkata",
      status: o.status,
      deleted_at: o.deleted ? new Date() : null,
      organizer_id: creator.id,
      organizer_org_id: orgId,
    },
  })
  events.push(e.id)
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
  await db.organiser_onboarding_requests.deleteMany({ where: { id: { in: requests } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await cleanup([], events)
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users.map((u) => u.id), [])
  await closeDb()
})

describe("the sweep", () => {
  it("nothing on day 2 or at 09:59 on day 3; one mail to each owner and admin at 10:00; none on a later pass or on day 4", async () => {
    const [owner1, owner2, admin, staff] = [await person("owner1"), await person("owner2"), await person("admin"), await person("staff")]
    const orgId = await approved(0, [[owner1, "owner"], [owner2, "owner"], [admin, "admin"], [staff, "staff"]])
    const everyone = [owner1, owner2, admin, staff]

    await sendFirstNightNudges(new Date(dueAt(0).getTime() - DAY))
    await sendFirstNightNudges(new Date(dueAt(0).getTime() - 60_000))
    expect(mailedTo(everyone)).toEqual([])
    expect(await nudgedAt(orgId)).toBeNull()

    await sendFirstNightNudges(dueAt(0))
    expect(mailedTo(everyone)).toEqual([admin.email, owner1.email, owner2.email].sort())
    expect(await nudgedAt(orgId)).toEqual(dueAt(0))
    const mail = mails.find((m) => m.to === owner1.email)!
    expect(mail.subject).toBe("List your first night on Blend’n")
    expect(mail.text).toContain("Create your first event:\n")
    expect(mail.tags).toEqual([{ name: "kind", value: "first_night" }])

    await sendFirstNightNudges(new Date(dueAt(0).getTime() + 5 * 60_000))
    await sendFirstNightNudges(new Date(dueAt(0).getTime() + DAY))
    expect(mailedTo(everyone)).toHaveLength(3)
  })

  it("three passes at once mail each person once", async () => {
    const [a, b] = [await person("race-a"), await person("race-b")]
    await approved(1, [[a, "owner"], [b, "admin"]])
    await Promise.all([sendFirstNightNudges(dueAt(1)), sendFirstNightNudges(dueAt(1)), sendFirstNightNudges(dueAt(1))])
    expect(mailedTo([a, b])).toEqual([a.email, b.email].sort())
  })

  it("never on day 4 or later: deploy day mails nobody approved weeks ago", async () => {
    const owner = await person("late")
    const orgId = await approved(2, [[owner, "owner"]])
    await sendFirstNightNudges(new Date(dueAt(2).getTime() + DAY))
    await sendFirstNightNudges(new Date(dueAt(2).getTime() + 20 * DAY))
    expect(mailedTo([owner])).toEqual([])
    expect(await nudgedAt(orgId)).toBeNull()
  })

  it("approved at 10:01 is due the fourth morning, and a pass 23 h 59 min after that still sends", async () => {
    const owner = await person("ten-oh-one")
    // 10:01 IST: 72 h on is 10:01 on day 3, so due is 10:00 on day 4, almost five days after approval.
    await approved(9, [[owner, "owner"]], { at: new Date(approvedAt(9).getTime() + 2 * 3600_000 + 60_000) })
    const due = new Date(dueAt(9).getTime() + DAY)
    await sendFirstNightNudges(new Date(due.getTime() - 60_000))
    expect(mailedTo([owner])).toEqual([])
    await sendFirstNightNudges(new Date(due.getTime() + DAY - 60_000))
    expect(mailedTo([owner])).toEqual([owner.email])
  })

  it("a Toronto organization at 10:00 EST across the clock change", async () => {
    const owner = await person("toronto")
    // Approved 08:00 EDT Thu 2033-11-03; clocks go back at 02:00 Sun 2033-11-06, so 10:00 that day is 15:00Z.
    await approved(3, [[owner, "owner"]], { city: "Toronto", at: new Date("2033-11-03T12:00:00Z") })
    await sendFirstNightNudges(new Date("2033-11-06T14:00:00Z"))
    await sendFirstNightNudges(new Date("2033-11-06T14:59:00Z"))
    expect(mailedTo([owner])).toEqual([])
    await sendFirstNightNudges(new Date("2033-11-06T15:00:00Z"))
    expect(mailedTo([owner])).toEqual([owner.email])
  })
})

describe("who never gets it", () => {
  it("an organization with any event, in any status, deleted or not: a draft means they have started", async () => {
    const owners = [await person("draft"), await person("cancelled"), await person("deleted"), await person("published")]
    const ids = [
      await approved(4, [[owners[0], "owner"]]),
      await approved(4, [[owners[1], "owner"]]),
      await approved(4, [[owners[2], "owner"]]),
      await approved(4, [[owners[3], "owner"]]),
    ]
    const ahead = new Date(dueAt(4).getTime() + 10 * DAY)
    await event(ids[0], { status: "draft", endedAt: ahead })
    await event(ids[1], { status: "cancelled", endedAt: ahead })
    await event(ids[2], { status: "draft", endedAt: ahead, deleted: true })
    await event(ids[3], { status: "published", endedAt: ahead })
    await sendFirstNightNudges(dueAt(4))
    expect(mailedTo(owners)).toEqual([])
    for (const id of ids) expect(await nudgedAt(id)).toBeNull()
  })

  it("a venue owner's or a sponsor's organization: their first step is not an event", async () => {
    const [venue, sponsor, host] = [await person("venue"), await person("sponsor"), await person("host")]
    await approved(5, [[venue, "owner"]], { role: "venue_owner" })
    await approved(5, [[sponsor, "owner"]], { role: "sponsor" })
    await approved(5, [[host, "owner"]])
    await sendFirstNightNudges(dueAt(5))
    expect(mailedTo([venue, sponsor, host])).toEqual([host.email])
  })

  it("a suspended organization, by either mark alone, and one nudged before", async () => {
    const [both, statusOnly, dateOnly, nudged] = [await person("suspended"), await person("status-only"), await person("date-only"), await person("nudged")]
    const ids = [
      await approved(6, [[both, "owner"]], { status: "suspended", suspendedAt: new Date() }),
      await approved(6, [[statusOnly, "owner"]], { status: "suspended" }),
      await approved(6, [[dateOnly, "owner"]], { suspendedAt: new Date() }),
    ]
    const before = new Date(dueAt(6).getTime() - 40 * DAY)
    const nudgedOrg = await approved(6, [[nudged, "owner"]], { nudgedAt: before })
    await sendFirstNightNudges(dueAt(6))
    expect(mailedTo([both, statusOnly, dateOnly, nudged])).toEqual([])
    for (const id of ids) expect(await nudgedAt(id)).toBeNull()
    expect(await nudgedAt(nudgedOrg)).toEqual(before)
  })

  it("an unsubscribed owner and a bounced admin are skipped; the other owner is mailed", async () => {
    const [unsubscribed, bounced, other] = [await person("unsub"), await person("bounced"), await person("other")]
    await approved(7, [[unsubscribed, "owner"], [bounced, "admin"], [other, "owner"]])
    await db.email_suppressions.create({ data: { email: unsubscribed.email, reason: "unsubscribe" } })
    await db.email_suppressions.create({ data: { email: bounced.email, reason: "bounce" } })
    await sendFirstNightNudges(dueAt(7))
    expect(mailedTo([unsubscribed, bounced, other])).toEqual([other.email])
  })
})

describe("with 04c's nudge", () => {
  it("a host nudged on day 3 who then holds a night gets no 'what's next?' inside 30 days; one never nudged does", async () => {
    const [nudgedHost, freshHost] = [await person("then-held"), await person("control")]
    const nudgedOrg = await approved(8, [[nudgedHost, "owner"]])
    await sendFirstNightNudges(dueAt(8))
    expect(mailedTo([nudgedHost])).toEqual([nudgedHost.email])

    // The control: an organization with the same night and no first-night nudge (approved earlier, already listing).
    // Approved 9 days before case 8: between case 7's and case 8's sweep windows, so no other case's pass reaches it.
    const freshOrg = await approved(8, [[freshHost, "owner"]], { at: new Date(approvedAt(8).getTime() - 9 * DAY) })
    // Both hold a night that ends at 01:30 IST two days after the nudge; 04c's 10:00 is a week on, inside 30 days of it.
    const ended = new Date(dueAt(8).getTime() + 2 * DAY - 8 * 3600_000 - 30 * 60_000)
    await event(nudgedOrg, { status: "published", endedAt: ended })
    await event(freshOrg, { status: "published", endedAt: ended })
    const weekOn = new Date(dueAt(8).getTime() + 9 * DAY)

    await sendNextNightNudges(weekOn)
    expect(mails.filter((m) => m.to === nudgedHost.email).map((m) => m.tags[0].value)).toEqual(["first_night"])
    expect(await nudgedAt(nudgedOrg)).toEqual(dueAt(8))
    expect(mails.filter((m) => m.to === freshHost.email).map((m) => m.tags[0].value)).toEqual(["next_night"])
  })
})
