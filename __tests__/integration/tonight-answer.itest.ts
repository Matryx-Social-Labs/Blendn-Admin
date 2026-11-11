import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

import { signAccessToken } from "@/lib/mobile-auth"
import { flushProductEvents } from "@/lib/product-events"
import { lensForEvent } from "@/lib/tonight"
import { venueDayFor } from "@/lib/venue-day"
import { slugify, TAXONOMY } from "@/scripts/seed-categories"

import { GET as prefsGet, PUT as prefsPut } from "@/app/api/mobile/events/[eventId]/matches/preferences/route"
import { GET as deckGet } from "@/app/api/mobile/events/[eventId]/matches/route"
import { GET as userGet } from "@/app/api/mobile/users/[userId]/route"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard, putInRoom, testId } from "./helpers"

/**
 * Tonight's question (Flow 5 · P-A, SCRUM-1042): the event's lens is data, the
 * answer is one per person per event, and it reaches people in that room and
 * nobody who runs it.
 */

interface Person {
  id: string
  token: string
}

const users: string[] = []
const events: string[] = []
const categories: string[] = []
const lensSlugs: string[] = []
const orgs: string[] = []
const venues: string[] = []

const ANSWER = "A robot that waters my balcony plants"

async function person(label: string, role: "attendee" | "organizer" = "attendee"): Promise<Person> {
  const id = await makeUser(label, role)
  users.push(id)
  await onboard(id)
  await db.profiles.update({ where: { id }, data: { date_of_birth: new Date("1994-01-01") } })
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function call(
  handler: (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>,
  path: string,
  as: Person,
  opts: { method?: string; body?: unknown; params: Record<string, string> }
) {
  const res = await handler(
    new NextRequest(`http://localhost${path}`, {
      method: opts.method ?? "GET",
      headers: { authorization: `Bearer ${as.token}`, "content-type": "application/json" },
      ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
    }),
    { params: Promise.resolve(opts.params) as Promise<never> }
  )
  const text = await res.text()
  return { status: res.status, text, body: text ? (JSON.parse(text) as any) : null } // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function category(label: string, parentId?: string) {
  const slug = testId(label)
  const c = await db.categories.create({ data: { name: slug, slug, parent_id: parentId ?? null } })
  categories.push(c.id)
  return c
}

/** A test category mapped to a lens, so resolution is tested without depending on the seeded taxonomy rows. */
async function mapped(label: string, lens: string, parentId?: string) {
  const c = await category(label, parentId)
  await db.category_lenses.create({ data: { category_slug: c.slug, lens_key: lens } })
  lensSlugs.push(c.slug)
  return c
}

async function eventIn(host: string, cats: { id: string; primary?: boolean }[]) {
  const id = await makeEvent(host)
  events.push(id)
  for (const c of cats) await db.event_categories.create({ data: { event_id: id, category_id: c.id, primary: c.primary ?? false } })
  return id
}

const prefsPath = (eventId: string) => `/api/mobile/events/${eventId}/matches/preferences`
const setAnswer = (as: Person, eventId: string, tonightAnswer: unknown) =>
  call(prefsPut, prefsPath(eventId), as, { method: "PUT", body: { tonightAnswer }, params: { eventId } })
const deck = (as: Person, eventId: string) =>
  call(deckGet, `/api/mobile/events/${eventId}/matches`, as, { params: { eventId } })
const profile = (as: Person, ref: string) => call(userGet, `/api/mobile/users/${ref}`, as, { params: { userId: ref } })

afterAll(async () => {
  await flushProductEvents()
  await cleanup(users, events)
  await db.category_lenses.deleteMany({ where: { category_slug: { in: lensSlugs } } })
  await db.event_categories.deleteMany({ where: { category_id: { in: categories } } })
  await db.categories.deleteMany({ where: { parent_id: { in: categories } } })
  await db.categories.deleteMany({ where: { id: { in: categories } } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

describe("the lens is data", () => {
  it("is seeded for every parent category in the taxonomy, each with the lens it names", async () => {
    const rows = await db.category_lenses.findMany({ include: { lens: true } })
    const lensOf = new Map(rows.map((r) => [r.category_slug, r.lens_key]))
    const parents = Object.keys(TAXONOMY).map(slugify)
    expect(parents.filter((slug) => !lensOf.has(slug))).toEqual([])
    expect(lensOf.get("tech")).toBe("work")
    expect(lensOf.get("music")).toBe("music")
    expect(lensOf.get("arts-culture")).toBe("arts")
    expect(lensOf.get("food-drink")).toBe("social")
    expect(lensOf.get("wellness")).toBe("active")
    const questions = await db.room_lenses.findMany({ orderBy: { key: "asc" } })
    expect(Object.fromEntries(questions.map((q) => [q.key, q.question]))).toEqual({
      active: "First time, or a regular?",
      arts: "What are you here to see?",
      music: "Who are you hoping they play?",
      social: "What should nobody miss?",
      venue_night: null,
      work: "What are you working on?",
    })
  })

  it("resolves the primary category first, then a child's parent, and null when nothing maps", async () => {
    const host = await makeUser("tq-lens-host", "organizer")
    users.push(host)
    const music = await mapped("tq-music", "music")
    const child = await category("tq-music-child", music.id)
    const arts = await mapped("tq-arts", "arts")
    const none = await category("tq-none")

    expect(await lensForEvent(await eventIn(host, [{ id: arts.id }, { id: music.id, primary: true }]))).toEqual({
      key: "music",
      question: "Who are you hoping they play?",
    })
    expect((await lensForEvent(await eventIn(host, [{ id: child.id, primary: true }])))?.key).toBe("music")
    expect(await lensForEvent(await eventIn(host, [{ id: none.id, primary: true }]))).toBeNull()
    expect(await lensForEvent(await eventIn(host, []))).toBeNull()
  })

  it("gives a venue day the venue-night lens, which asks nothing", async () => {
    const v = await db.venues.create({
      data: { name: testId("tq-venue"), city: "Toronto", latitude: 43.65, longitude: -79.38, timezone: "America/Toronto", day_reset_hour: 6 },
    })
    venues.push(v.id)
    const day = await venueDayFor(v.id)
    if (!day) throw new Error("no venue day")
    events.push(day.id)
    expect(await lensForEvent(day.id)).toEqual({ key: "venue_night", question: null })
  })
})

describe("tonight's answer", () => {
  let a: Person
  let b: Person
  let host: Person
  let outsider: Person
  let eventId: string
  let noQuestionEvent: string
  let orgId: string
  let handleOfA: string

  beforeAll(async () => {
    a = await person("tq-a")
    b = await person("tq-b")
    host = await person("tq-host", "organizer")
    outsider = await person("tq-outsider")
    const work = await mapped("tq-work", "work")
    eventId = await eventIn(host.id, [{ id: work.id, primary: true }])
    noQuestionEvent = await eventIn(host.id, [])
    const org = await db.organisations.create({ data: { display_name: testId("tq-org") } })
    orgs.push(org.id)
    orgId = org.id
    await db.events.update({ where: { id: eventId }, data: { organizer_org_id: orgId } })
    const occurrence = await occurrenceOf(eventId)
    for (const p of [a, b, host]) await putInRoom({ eventId, occurrenceId: occurrence, userId: p.id })
  }, 60_000)

  it("is not yours to read or write until you are in the room", async () => {
    expect((await call(prefsGet, prefsPath(eventId), outsider, { params: { eventId } })).status).toBe(403)
    expect((await setAnswer(outsider, eventId, ANSWER)).status).toBe(403)
  })

  it("starts empty, with the room's question", async () => {
    const r = await call(prefsGet, prefsPath(eventId), a, { params: { eventId } })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({
      tonightAnswer: null,
      revealed: false,
      lens: { key: "work", question: "What are you working on?" },
    })
  })

  it("is trimmed and collapsed to one line, capped at 140, and moderated", async () => {
    const saved = await setAnswer(a, eventId, `  A robot that\n waters   my balcony plants  `)
    expect(saved.status).toBe(200)
    expect(saved.body.data.tonightAnswer).toBe(ANSWER)
    expect(saved.body.data.lens.key).toBe("work")

    expect((await setAnswer(a, eventId, "x".repeat(141))).status).toBe(400)
    // 140 emoji is 140 characters, not 280 UTF-16 units.
    expect((await setAnswer(b, eventId, "🎧".repeat(140))).status).toBe(200)
    const refused = await setAnswer(a, eventId, "you retard")
    expect(refused.status).toBe(400)
    expect(refused.body.reasonCode).toBe("TEXT_NOT_ALLOWED")
    expect(refused.body.field).toBe("tonightAnswer")
    expect((await setAnswer(a, eventId, 42)).status).toBe(400)

    // A refusal wrote nothing.
    const row = await db.event_match_preferences.findUnique({ where: { event_id_user_id: { event_id: eventId, user_id: a.id } } })
    expect(row?.tonight_answer).toBe(ANSWER)
  })

  it("is refused in a room with no question", async () => {
    const occurrence = await occurrenceOf(noQuestionEvent)
    const c = await person("tq-c")
    await putInRoom({ eventId: noQuestionEvent, occurrenceId: occurrence, userId: c.id })
    const r = await setAnswer(c, noQuestionEvent, "anything")
    expect(r.status).toBe(400)
    // Clearing is always allowed.
    expect((await setAnswer(c, noQuestionEvent, null)).status).toBe(200)
  })

  it("reaches another attendee on the deck and on the person sheet", async () => {
    const d = await deck(b, eventId)
    expect(d.status).toBe(200)
    expect(d.body.data.lens).toEqual({ key: "work", question: "What are you working on?" })
    const card = (d.body.data.matches as { userId: string; tonightAnswer: string | null }[]).find((m) => m.tonightAnswer === ANSWER)
    expect(card).toBeDefined()
    handleOfA = card!.userId
    expect(handleOfA).not.toBe(a.id)

    const p = await profile(b, handleOfA)
    expect(p.status).toBe(200)
    expect(p.body.data.identityVisible).toBe(false)
    expect(p.body.data.tonight).toEqual({ lens: { key: "work", question: "What are you working on?" }, answer: ANSWER, workIntent: null })
  })

  it("never reaches somebody who was not in the room, nor anyone asking by raw id", async () => {
    const p = await profile(outsider, handleOfA)
    expect(p.text).not.toContain(ANSWER)
    expect(p.body.data?.tonight).toBeUndefined()
    const raw = await profile(b, a.id)
    expect(raw.text).not.toContain(ANSWER)
  })

  it("reaches a checked-in organizer outside the org (the control), and never one who runs the event", async () => {
    // Control: in the room, not yet a member of the organising org -- just an attendee, who sees it.
    expect((await deck(host, eventId)).text).toContain(ANSWER)
    expect((await profile(host, handleOfA)).text).toContain(ANSWER)

    await db.organisation_members.create({ data: { org_id: orgId, user_id: host.id, role: "staff" } })
    const d = await deck(host, eventId)
    expect(d.status).toBe(200)
    expect(d.text).not.toContain(ANSWER)
    expect((d.body.data.matches as { tonightAnswer: unknown }[]).every((m) => m.tonightAnswer === null)).toBe(true)
    const p = await profile(host, handleOfA)
    expect(p.text).not.toContain(ANSWER)
    expect(p.body.data.tonight).toBeUndefined()
  })

  it("clears with null or an empty string", async () => {
    const r = await setAnswer(a, eventId, "   ")
    expect(r.status).toBe(200)
    expect(r.body.data.tonightAnswer).toBeNull()
    expect((await profile(b, handleOfA)).body.data.tonight).toEqual({ lens: { key: "work", question: "What are you working on?" }, answer: null, workIntent: null })
  })

  it("is not readable on the person sheet once a host bans its author from the room, as the deck already drops them", async () => {
    const BANNED_ANSWER = "Teaching my cat to fetch"
    const d = await person("tq-d")
    await putInRoom({ eventId, occurrenceId: await occurrenceOf(eventId), userId: d.id })
    expect((await setAnswer(d, eventId, BANNED_ANSWER)).status).toBe(200)
    const card = ((await deck(b, eventId)).body.data.matches as { userId: string; tonightAnswer: string | null }[]).find(
      (m) => m.tonightAnswer === BANNED_ANSWER
    )
    // Control: before the ban, b reads it on the sheet.
    expect((await profile(b, card!.userId)).text).toContain(BANNED_ANSWER)

    const group = await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active", member_count: 0 } })
    await db.chat_group_members.create({
      data: { chat_group_id: group.id, user_id: d.id, anonymous_name: testId("Otter"), status: "banned", banned_by: host.id },
    })

    expect((await deck(b, eventId)).text).not.toContain(BANNED_ANSWER)
    const p = await profile(b, card!.userId)
    expect(p.text).not.toContain(BANNED_ANSWER)
  })
})

describe("why I'm here (the work lens)", () => {
  let a: Person
  let b: Person
  let host: Person
  let outsider: Person
  let eventId: string
  let musicEvent: string
  let orgId: string
  let handleOfA: string

  const setIntent = (as: Person, event: string, workIntent: unknown) =>
    call(prefsPut, prefsPath(event), as, { method: "PUT", body: { workIntent }, params: { eventId: event } })
  type Card = { userId: string; workIntent: string | null; tonightAnswer: string | null }
  const cardsOf = async (as: Person, event: string) => (await deck(as, event)).body.data.matches as Card[]

  beforeAll(async () => {
    a = await person("wi-a")
    b = await person("wi-b")
    host = await person("wi-host", "organizer")
    outsider = await person("wi-outsider")
    eventId = await eventIn(host.id, [{ id: (await mapped("wi-work", "work")).id, primary: true }])
    musicEvent = await eventIn(host.id, [{ id: (await mapped("wi-music", "music")).id, primary: true }])
    const org = await db.organisations.create({ data: { display_name: testId("wi-org") } })
    orgs.push(org.id)
    orgId = org.id
    await db.events.update({ where: { id: eventId }, data: { organizer_org_id: orgId } })
    for (const ev of [eventId, musicEvent]) {
      const occurrence = await occurrenceOf(ev)
      for (const p of [a, b, host]) await putInRoom({ eventId: ev, occurrenceId: occurrence, userId: p.id })
    }
  }, 60_000)

  it("starts unset, and is not yours to write until you are in the room", async () => {
    expect((await call(prefsGet, prefsPath(eventId), a, { params: { eventId } })).body.data.workIntent).toBeNull()
    expect((await setIntent(outsider, eventId, "hire")).status).toBe(403)
  })

  it("takes one of hire, find_work, build or learn, and nothing else", async () => {
    for (const v of ["find_work", "build", "learn", "hire"]) {
      const r = await setIntent(a, eventId, v)
      expect(r.status).toBe(200)
      expect(r.body.data.workIntent).toBe(v)
    }
    for (const bad of ["boss", "", ["hire"], 3]) expect((await setIntent(a, eventId, bad)).status).toBe(400)
    const row = await db.event_match_preferences.findUnique({ where: { event_id_user_id: { event_id: eventId, user_id: a.id } } })
    expect(row?.work_intent).toBe("hire")
  })

  it("is left alone by a write that does not name it", async () => {
    expect((await setAnswer(a, eventId, "A bike-share map")).status).toBe(200)
    expect((await call(prefsGet, prefsPath(eventId), a, { params: { eventId } })).body.data.workIntent).toBe("hire")
  })

  it("is refused in a room that is not the work lens, and clearing there is always allowed", async () => {
    const r = await setIntent(a, musicEvent, "hire")
    expect(r.status).toBe(400)
    expect((await setIntent(a, musicEvent, null)).status).toBe(200)
  })

  it("reaches another attendee on the deck and on the person sheet", async () => {
    const card = (await cardsOf(b, eventId)).find((m) => m.workIntent === "hire")
    expect(card).toBeDefined()
    handleOfA = card!.userId
    const p = await profile(b, handleOfA)
    expect(p.body.data.identityVisible).toBe(false)
    expect(p.body.data.tonight).toMatchObject({ lens: { key: "work" }, workIntent: "hire" })
  })

  it("is read only in a work-lens room, even when a row holds one (a category changed after it was set)", async () => {
    await db.event_match_preferences.update({
      where: { event_id_user_id: { event_id: musicEvent, user_id: a.id } },
      data: { work_intent: "build" },
    })
    const cards = await cardsOf(b, musicEvent)
    expect(cards.length).toBeGreaterThan(0)
    expect(cards.every((m) => m.workIntent === null)).toBe(true)
    for (const c of cards) expect((await profile(b, c.userId)).body.data.tonight.workIntent).toBeNull()
  })

  it("never reaches somebody who was not in the room, nor anyone asking by raw id", async () => {
    expect((await profile(outsider, handleOfA)).text).not.toContain("workIntent")
    expect((await profile(b, a.id)).text).not.toContain("workIntent")
  })

  it("reaches a checked-in organizer outside the org (the control), and never one who runs the event", async () => {
    expect((await cardsOf(host, eventId)).some((m) => m.workIntent === "hire")).toBe(true)
    expect((await profile(host, handleOfA)).body.data.tonight.workIntent).toBe("hire")

    await db.organisation_members.create({ data: { org_id: orgId, user_id: host.id, role: "staff" } })
    expect((await cardsOf(host, eventId)).every((m) => m.workIntent === null)).toBe(true)
    const p = await profile(host, handleOfA)
    expect(p.text).not.toContain("workIntent")
  })

  it("clears with null", async () => {
    expect((await setIntent(a, eventId, null)).body.data.workIntent).toBeNull()
    expect((await profile(b, handleOfA)).body.data.tonight.workIntent).toBeNull()
    expect((await setIntent(a, eventId, "hire")).status).toBe(200)
  })

  it("is not readable on the person sheet once a host bans its author from the room", async () => {
    // Control: before the ban, b reads it.
    expect((await profile(b, handleOfA)).body.data.tonight.workIntent).toBe("hire")
    const group = await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active", member_count: 0 } })
    await db.chat_group_members.create({
      data: { chat_group_id: group.id, user_id: a.id, anonymous_name: testId("Bison"), status: "banned", banned_by: host.id },
    })
    expect((await cardsOf(b, eventId)).some((m) => m.workIntent === "hire")).toBe(false)
    expect((await profile(b, handleOfA)).body.data.tonight.workIntent).toBeNull()
  })
})
