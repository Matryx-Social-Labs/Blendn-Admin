/*
 * The host's morning results mail and its unsubscribe (SCRUM-1282, launch gate 14), on a db:migrate database: the
 * sweep through real Postgres with Resend's fetch captured, and the unsubscribe route through the real handler. Every
 * count reads this suite's own rows only (its events, its addresses): the itest database is shared.
 */
import { randomUUID } from "crypto"
import { NextRequest } from "next/server"

import { sendResultsMails } from "@/lib/results-mail"
import { unsubscribeToken } from "@/lib/unsubscribe"

import { cleanup, closeDb, db, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const route = require("@/app/api/email/unsubscribe/route") as typeof import("@/app/api/email/unsubscribe/route")
/* eslint-enable @typescript-eslint/no-require-imports */

process.env.NEXTAUTH_SECRET ??= "itest-results-mail-secret-of-forty-chars!!"

/** A network this run alone uses: the limiter's counters may outlive one run. */
const net = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}`

/** 10:00 IST on a day no other suite's fixture ends near. */
const NOW = new Date("2031-03-14T04:30:00Z")
const LAST_NIGHT = new Date("2031-03-13T17:30:00Z")

const users: { id: string; email: string }[] = []
const orgs: string[] = []
const events: string[] = []
const mails: { to: string; subject: string; text: string }[] = []
let resendStatus = 200
let realFetch: typeof fetch

async function person(label: string) {
  const id = testId(label)
  const email = `itest-${label}-${randomUUID().slice(0, 8)}@resend.dev`
  await db.user.create({ data: { id, email, name: `Test ${label}`, role: "organizer" } })
  const user = { id, email }
  users.push(user)
  return user
}

async function org(members: [{ id: string }, "owner" | "admin" | "staff"][]) {
  const o = await db.organisations.create({ data: { kind: "company", display_name: testId("rm-org"), status: "verified" } })
  orgs.push(o.id)
  for (const [user, role] of members) await db.organisation_members.create({ data: { org_id: o.id, user_id: user.id, role } })
  return o.id
}

async function night(orgId: string | null, o: { endedAt?: Date; status?: "published" | "completed" | "cancelled"; came?: number } = {}) {
  const end = o.endedAt ?? LAST_NIGHT
  const host = users[0]
  const event = await db.events.create({
    data: {
      slug: testId("rm-evt"),
      title: "Results night",
      description: "integration fixture",
      start_time: new Date(end.getTime() - 4 * 3600_000),
      end_time: end,
      timezone: "Asia/Kolkata",
      status: o.status ?? "published",
      organizer_id: host.id,
      organizer_org_id: orgId,
    },
  })
  events.push(event.id)
  const occurrence = await db.event_occurrences.create({
    data: { event_id: event.id, occurs_on: new Date(event.start_time.toISOString().slice(0, 10)), start_time: event.start_time, end_time: end },
  })
  for (let i = 0; i < (o.came ?? 6); i++) {
    const guest = await person(`guest${i}`)
    await db.event_check_ins.create({
      data: { event_id: event.id, occurrence_id: occurrence.id, user_id: guest.id, kind: "attendee", status: "checked_out", check_in_time: event.start_time },
    })
  }
  return event.id
}

const mailedTo = (eventTitleFree: { email: string }[]) => mails.filter((m) => eventTitleFree.some((u) => u.email === m.to)).map((m) => m.to).sort()

beforeAll(() => {
  process.env.RESEND_API_KEY = "re_itest"
  process.env.EMAIL_FROM = "Blend'n <hello@blendn.app>"
  realFetch = global.fetch
  global.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { to: string[]; subject: string; text: string }
    if (resendStatus === 200) mails.push({ to: body.to[0], subject: body.subject, text: body.text })
    return new Response(JSON.stringify({ id: randomUUID() }), { status: resendStatus })
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
  it("mails each owner and admin once, nobody else, and a second pass mails nobody", async () => {
    const [owner1, owner2, admin, staff, left, suspended] = [await person("owner1"), await person("owner2"), await person("admin"), await person("staff"), await person("left"), await person("suspended")]
    const orgId = await org([[owner1, "owner"], [owner2, "owner"], [admin, "admin"], [staff, "staff"], [left, "admin"], [suspended, "owner"]])
    await db.user.update({ where: { id: suspended.id }, data: { suspended_at: new Date() } })
    // A member who left: their membership row is gone.
    await db.organisation_members.deleteMany({ where: { org_id: orgId, user_id: left.id } })
    const id = await night(orgId)

    // 09:59 IST: not yet.
    await sendResultsMails(new Date(NOW.getTime() - 60_000))
    expect(mailedTo([owner1, owner2, admin, staff, left])).toEqual([])

    await sendResultsMails(NOW)
    expect(mailedTo([owner1, owner2, admin, staff, left, suspended])).toEqual([admin.email, owner1.email, owner2.email].sort())
    // The figures as Postgres gives them: six people (the real distinct count), fewer than 5 raters, no mood rows.
    const body = mails.find((m) => m.to === owner1.email)!
    expect(body.subject).toBe("Results night: your night in numbers")
    expect(body.text).toContain("6 people checked in on Blend’n.")
    // The Overview's mood builder, run for real: no classified messages, so no mood line.
    expect(body.text).not.toContain("room’s mood")
    expect(body.text).toContain(`/dashboard/events/${id}\n`)
    expect((await db.events.findUnique({ where: { id }, select: { results_mailed_at: true } }))?.results_mailed_at).toEqual(NOW)

    await sendResultsMails(new Date(NOW.getTime() + 5 * 60_000))
    expect(mailedTo([owner1, owner2, admin])).toHaveLength(3)
  })

  it("two passes at once (two replicas, or a slow pass and the next) mail each person once", async () => {
    const [a, b] = [await person("race-a"), await person("race-b")]
    const orgId = await org([[a, "owner"], [b, "admin"]])
    await night(orgId)
    await Promise.all([sendResultsMails(NOW), sendResultsMails(NOW), sendResultsMails(NOW)])
    expect(mailedTo([a, b])).toEqual([a.email, b.email].sort())
  })

  it("a completed night is mailed; a night with no organization never is", async () => {
    const owner = await person("owner-completed")
    const orgId = await org([[owner, "owner"]])
    const done = await night(orgId, { status: "completed" })
    const orphan = await night(null)
    await sendResultsMails(NOW)
    expect(mailedTo([owner])).toEqual([owner.email])
    const rows = await db.events.findMany({ where: { id: { in: [done, orphan] } }, select: { id: true, results_mailed_at: true } })
    expect(rows.find((r) => r.id === orphan)?.results_mailed_at).toBeNull()
  })

  it("zero check-ins: the org's first mailed night gets the help mail, its next zero night nothing", async () => {
    const owner = await person("owner-zero")
    const orgId = await org([[owner, "owner"]])
    await night(orgId, { came: 0, endedAt: new Date(LAST_NIGHT.getTime() - 24 * 3600_000) })
    await sendResultsMails(new Date(NOW.getTime() - 24 * 3600_000))
    expect(mails.filter((m) => m.to === owner.email).map((m) => m.subject)).toEqual(["Results night: no check-ins on Blend’n"])
    await night(orgId, { came: 0 })
    await sendResultsMails(NOW)
    expect(mails.filter((m) => m.to === owner.email)).toHaveLength(1)
  })

  it("a night nobody got because Resend failed is given back, and the next pass sends it", async () => {
    const owner = await person("owner-retry")
    const orgId = await org([[owner, "owner"]])
    const id = await night(orgId)
    resendStatus = 422
    await sendResultsMails(NOW)
    resendStatus = 200
    expect((await db.events.findUnique({ where: { id }, select: { results_mailed_at: true } }))?.results_mailed_at).toBeNull()
    await sendResultsMails(new Date(NOW.getTime() + 5 * 60_000))
    expect(mailedTo([owner])).toEqual([owner.email])
  })

  it("never mails a night older than 34 h or a cancelled one", async () => {
    const owner = await person("owner-old")
    const orgId = await org([[owner, "owner"]])
    const old = await night(orgId, { endedAt: new Date(NOW.getTime() - 35 * 3600_000) })
    const cancelled = await night(orgId, { status: "cancelled" })
    await sendResultsMails(NOW)
    expect(mailedTo([owner])).toEqual([])
    const rows = await db.events.findMany({ where: { id: { in: [old, cancelled] } }, select: { results_mailed_at: true } })
    expect(rows.every((r) => r.results_mailed_at === null)).toBe(true)
  })

  it("skips an owner who unsubscribed, and still mails the other", async () => {
    const [a, b] = [await person("unsub-a"), await person("unsub-b")]
    const orgId = await org([[a, "owner"], [b, "owner"]])
    await db.email_suppressions.create({ data: { email: a.email, reason: "unsubscribe" } })
    await night(orgId)
    await sendResultsMails(NOW)
    expect(mailedTo([a, b])).toEqual([b.email])
  })
})

describe("POST /api/email/unsubscribe", () => {
  const post = (t: string | null, ip: string, query = "") =>
    route.POST(
      new NextRequest(`http://localhost/api/email/unsubscribe${t === null ? "" : `?t=${encodeURIComponent(t)}`}${query}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-real-ip": ip },
        body: "List-Unsubscribe=One-Click",
      })
    )
  const rows = (email: string) => db.email_suppressions.findMany({ where: { email }, select: { reason: true } })

  it("one-click writes one unsubscribe row; a repeat stays one row", async () => {
    const u = await person("oneclick")
    expect((await post(unsubscribeToken(u), net())).status).toBe(200)
    expect((await post(unsubscribeToken(u), net())).status).toBe(200)
    expect(await rows(u.email)).toEqual([{ reason: "unsubscribe" }])
  })

  it("the confirm page's form is sent back to the page", async () => {
    const u = await person("formpost")
    const res = await post(unsubscribeToken(u), net(), "&from=page")
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/unsubscribe?done=1")
    expect(await rows(u.email)).toEqual([{ reason: "unsubscribe" }])
  })

  it("never downgrades a bounce or a complaint", async () => {
    const u = await person("bounced")
    await db.email_suppressions.create({ data: { email: u.email, reason: "bounce" } })
    expect((await post(unsubscribeToken(u), net())).status).toBe(200)
    expect(await rows(u.email)).toEqual([{ reason: "bounce" }])
  })

  it("a bad token is 400 and writes nothing", async () => {
    const u = await person("badtoken")
    const good = unsubscribeToken(u)
    const other = await person("othertoken")
    const bad = [
      null,
      "",
      "nodot",
      `${u.id}.`,
      `${u.id}.${good.split(".")[1].slice(0, -2)}AA`,
      `${other.id}.${good.split(".")[1]}`,
      `${good}.extra`,
      `../../etc.${good.split(".")[1]}`,
    ]
    for (const t of bad) expect((await post(t, net())).status).toBe(400)
    expect(await rows(u.email)).toEqual([])
    expect(await rows(other.email)).toEqual([])
  })

  it("a deleted account's link is 400", async () => {
    const u = await person("deleted")
    await db.user.update({ where: { id: u.id }, data: { deletedAt: new Date() } })
    expect((await post(unsubscribeToken(u), net())).status).toBe(400)
    expect(await rows(u.email)).toEqual([])
  })

  it("is rate-limited per network: 120 a minute, then 429", async () => {
    const ip = net()
    const statuses: number[] = []
    for (let i = 0; i < 121; i++) statuses.push((await post("x.y", ip)).status)
    expect(statuses.slice(0, 120).every((s) => s === 400)).toBe(true)
    expect(statuses[120]).toBe(429)
  })

  it("a bad token from the confirm page goes back to the page, which says the link does not work", async () => {
    const res = await post("x.y", net(), "&from=page")
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/unsubscribe?t=x.y")
  })
})

describe("GET /api/email/unsubscribe", () => {
  it("sends a person to the confirm page and writes nothing (link scanners GET every link)", async () => {
    const u = await person("scanner")
    const t = unsubscribeToken(u)
    const res = await route.GET(new NextRequest(`http://localhost/api/email/unsubscribe?t=${encodeURIComponent(t)}`))
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe(`/unsubscribe?t=${encodeURIComponent(t)}`)
    expect(await db.email_suppressions.findMany({ where: { email: u.email } })).toEqual([])
  })

  it("without a token goes to the page, which says the link does not work", async () => {
    const res = await route.GET(new NextRequest("http://localhost/api/email/unsubscribe"))
    expect(res.headers.get("location")).toBe("/unsubscribe?t=")
  })
})
