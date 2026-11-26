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

/** 10:00 IST on a day no other suite's fixture ends near. */
const NOW = new Date("2031-03-14T04:30:00Z")
const LAST_NIGHT = new Date("2031-03-13T17:30:00Z")

const users: { id: string; email: string }[] = []
const orgs: string[] = []
const events: string[] = []
const mails: { to: string; subject: string }[] = []
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

async function night(orgId: string, o: { endedAt?: Date; status?: "published" | "completed" | "cancelled"; came?: number } = {}) {
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
    const body = JSON.parse(init.body) as { to: string[]; subject: string }
    mails.push({ to: body.to[0], subject: body.subject })
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
  it("mails each owner and admin once, nobody else, and a second pass mails nobody", async () => {
    const [owner1, owner2, admin, staff, left] = [await person("owner1"), await person("owner2"), await person("admin"), await person("staff"), await person("left")]
    const orgId = await org([[owner1, "owner"], [owner2, "owner"], [admin, "admin"], [staff, "staff"], [left, "admin"]])
    // A member who left: their membership row is gone.
    await db.organisation_members.deleteMany({ where: { org_id: orgId, user_id: left.id } })
    const id = await night(orgId)

    // 09:59 IST: not yet.
    await sendResultsMails(new Date(NOW.getTime() - 60_000))
    expect(mailedTo([owner1, owner2, admin, staff, left])).toEqual([])

    await sendResultsMails(NOW)
    expect(mailedTo([owner1, owner2, admin, staff, left])).toEqual([admin.email, owner1.email, owner2.email].sort())
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

  it("never mails a night older than 34 h, a cancelled one, or an event with no organization", async () => {
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
    expect((await post(unsubscribeToken(u), "203.0.113.41")).status).toBe(200)
    expect((await post(unsubscribeToken(u), "203.0.113.41")).status).toBe(200)
    expect(await rows(u.email)).toEqual([{ reason: "unsubscribe" }])
  })

  it("the confirm page's form is sent back to the page", async () => {
    const u = await person("formpost")
    const res = await post(unsubscribeToken(u), "203.0.113.42", "&from=page")
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/unsubscribe?done=1")
    expect(await rows(u.email)).toEqual([{ reason: "unsubscribe" }])
  })

  it("never downgrades a bounce or a complaint", async () => {
    const u = await person("bounced")
    await db.email_suppressions.create({ data: { email: u.email, reason: "bounce" } })
    expect((await post(unsubscribeToken(u), "203.0.113.43")).status).toBe(200)
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
    for (const t of bad) expect((await post(t, "203.0.113.44")).status).toBe(400)
    expect(await rows(u.email)).toEqual([])
    expect(await rows(other.email)).toEqual([])
  })

  it("a deleted account's link is 400", async () => {
    const u = await person("deleted")
    await db.user.update({ where: { id: u.id }, data: { deletedAt: new Date() } })
    expect((await post(unsubscribeToken(u), "203.0.113.46")).status).toBe(400)
    expect(await rows(u.email)).toEqual([])
  })

  it("is rate-limited per network", async () => {
    const statuses: number[] = []
    for (let i = 0; i < 25; i++) statuses.push((await post("x.y", "203.0.113.45")).status)
    expect(statuses).toContain(429)
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
})
