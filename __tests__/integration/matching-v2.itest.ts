jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { NextRequest } from "next/server"

import { matchesForEvent, type MatchCard } from "@/lib/matches"
import { signAccessToken } from "@/lib/mobile-auth"
import { resolveUserRef } from "@/lib/room-handle"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard, putInRoom, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const profileRoute = require("@/app/api/mobile/profiles/[userId]/route") as typeof import("@/app/api/mobile/profiles/[userId]/route")
const userRoute = require("@/app/api/mobile/users/[userId]/route") as typeof import("@/app/api/mobile/users/[userId]/route")
const thisOrThatRoute = require("@/app/api/mobile/me/this-or-that/route") as typeof import("@/app/api/mobile/me/this-or-that/route")
const optionsRoute = require("@/app/api/mobile/profile-options/route") as typeof import("@/app/api/mobile/profile-options/route")
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Matching v2 against a real database built with `db:migrate` (step 10,
 * MV-I01..I06): the IPL leaves the migration writes, the room's own rarity,
 * the Tier B budget at seven and at eight, zodiac and origin never moving a
 * ranking, badges from check-ins, the profile fields and this-or-that.
 */

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.event_rsvps.deleteMany({ where: { user_id: { in: users } } })
  await db.user_interests.deleteMany({ where: { user_id: { in: users } } })
  await db.presence_sessions.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, events)
  await db.venues.deleteMany({ where: { owner_id: { in: users } } })
  await closeDb()
})

async function adult(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  await db.profiles.update({ where: { id }, data: { age: 28, intent_default: ["friendship"] } })
  return id
}

async function room(venueId: string | null = null) {
  const host = await makeUser(testId("mv-host"), "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  if (venueId) await db.events.update({ where: { id: eventId }, data: { venue_id: venueId } })
  await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" } })
  return { eventId, occurrenceId: await occurrenceOf(eventId) }
}

/** Checked in now; `minutesAgo` sets who arrived last, which leads a tie. */
async function arrive(r: { eventId: string; occurrenceId: string }, userId: string, minutesAgo = 30) {
  await putInRoom({ ...r, userId, at: new Date(Date.now() - minutesAgo * 60_000) })
}

const leaf = async (slug: string) => (await db.categories.findUniqueOrThrow({ where: { slug }, select: { id: true } })).id
const likes = async (userId: string, ...slugs: string[]) => {
  for (const slug of slugs) await db.user_interests.create({ data: { user_id: userId, category_id: await leaf(slug) } })
}

const cardOf = (cards: MatchCard[], userId: string) => cards.find((c) => resolveUserRef(c.userId)?.userId === userId)!
const order = (cards: MatchCard[]) => cards.map((c) => resolveUserRef(c.userId)?.userId)
const TIER_B = ["language", "home_state", "sign"]

/** A room of `others` people beside the viewer: fillers who share nothing. */
async function fill(r: { eventId: string; occurrenceId: string }, n: number) {
  for (let i = 0; i < n; i++) await arrive(r, await adult(`mv-fill-${i}`), 90 + i)
}

describe("Both CSK — in RCB country outranks Both RCB (MV-I01)", () => {
  it("ranks the rare team first and says why, on the leaves the migration wrote", async () => {
    const r = await room()
    const me = await adult("mv-csk-me")
    await likes(me, "ipl-csk", "ipl-rcb")
    await arrive(r, me, 120)

    const cskFan = await adult("mv-csk")
    await likes(cskFan, "ipl-csk")
    await arrive(r, cskFan, 60)
    // Arrived last, so on an equal score this RCB fan would lead.
    const rcbFan = await adult("mv-rcb")
    await likes(rcbFan, "ipl-rcb")
    await arrive(r, rcbFan, 1)
    for (let i = 0; i < 6; i++) {
      const fan = await adult(`mv-rcb-${i}`)
      await likes(fan, "ipl-rcb")
      await arrive(r, fan, 100 + i)
    }

    const cards = (await matchesForEvent(r.eventId, me))!
    expect(order(cards)[0]).toBe(cskFan)
    expect(order(cards).indexOf(rcbFan)).toBeGreaterThan(0)
    expect(cardOf(cards, cskFan).overlaps).toContainEqual({ kind: "ipl", text: "Both CSK — in RCB country 💛" })
    expect(cardOf(cards, rcbFan).overlaps).toContainEqual({ kind: "ipl", text: "Both RCB fans ❤️" })
  })
})

describe("the Tier B budget, at seven and at eight (MV-I02)", () => {
  const shared = { languages: ["malayalam"], home_state: "kerala", sun_sign: "leo", sign_system: "western" }

  it("no Tier B line and no sign in a room of seven; one at eight; all of them once revealed", async () => {
    const r = await room()
    const me = await adult("mv-b-me")
    const them = await adult("mv-b-them")
    await db.profiles.updateMany({ where: { id: { in: [me, them] } }, data: shared })
    await db.this_or_that_answers.createMany({
      data: [me, them].map((user_id) => ({ user_id, question: "coffee_or_chai", choice: "a" })),
    })
    await arrive(r, me)
    await arrive(r, them)
    await fill(r, 6) // seven others

    const seven = cardOf((await matchesForEvent(r.eventId, me))!, them)
    expect(seven.overlaps.filter((o) => TIER_B.includes(o.kind))).toEqual([])
    expect(seven.overlaps).toEqual([{ kind: "this_or_that", text: "You both picked filter coffee over chai" }])
    expect(seven.sign).toBeNull()

    await fill(r, 1) // eight others
    const eight = cardOf((await matchesForEvent(r.eventId, me))!, them)
    expect(eight.overlaps.filter((o) => TIER_B.includes(o.kind))).toHaveLength(1)
    // The budget is spent on the line, so no sign chip beside it.
    expect(eight.sign).toBeNull()

    await db.event_match_preferences.upsert({
      where: { event_id_user_id: { event_id: r.eventId, user_id: them } },
      create: { event_id: r.eventId, user_id: them, revealed: true },
      update: { revealed: true },
    })
    const revealed = cardOf((await matchesForEvent(r.eventId, me))!, them)
    expect(revealed.overlaps.filter((o) => TIER_B.includes(o.kind)).map((o) => o.kind).sort()).toEqual([
      "home_state",
      "language",
      "sign",
    ])
  })
})

describe("zodiac, origin and this-or-that never move a ranking (MV-I03)", () => {
  it("the room ranks the same whatever is shared that is display only", async () => {
    const r = await room()
    const me = await adult("mv-z-me")
    const plain = await adult("mv-z-plain")
    const twin = await adult("mv-z-twin")
    await db.profiles.updateMany({
      where: { id: { in: [me, twin] } },
      data: { languages: ["tulu", "kannada"], home_state: "karnataka", sun_sign: "scorpio", sign_system: "rashi" },
    })
    await db.this_or_that_answers.createMany({
      data: [me, twin].flatMap((user_id) => [
        { user_id, question: "metro_or_auto", choice: "a" },
        { user_id, question: "early_or_night", choice: "b" },
      ]),
    })
    await arrive(r, me, 200)
    await arrive(r, twin, 50)
    // Arrived after the twin: everything that ranks is equal, so recency leads.
    await arrive(r, plain, 5)
    await fill(r, 8)

    const withTraits = order((await matchesForEvent(r.eventId, me))!)
    expect(withTraits.indexOf(plain)).toBeLessThan(withTraits.indexOf(twin))

    await db.this_or_that_answers.deleteMany({ where: { user_id: twin } })
    await db.profiles.update({
      where: { id: twin },
      data: { languages: [], home_state: null, sun_sign: null, sign_system: null },
    })
    expect(order((await matchesForEvent(r.eventId, me))!)).toEqual(withTraits)
  })
})

describe("badges from check-ins (MV-I04)", () => {
  it("Regular here at this venue, 5+ nights, Shows up only when turned on — and none in a room of seven", async () => {
    const owner = await makeUser(testId("mv-v-owner"), "organizer")
    users.push(owner)
    const venue = await db.venues.create({ data: { name: testId("Toit"), owner_id: owner }, select: { id: true } })
    const r = await room(venue.id)
    const me = await adult("mv-bd-me")
    const regular = await adult("mv-bd-regular")
    const keen = await adult("mv-bd-keen")
    await db.profiles.update({ where: { id: keen }, data: { shows_up_badge: true } })

    // Two earlier nights at this venue for the regular, and four more nights
    // out anywhere; the keen one kept three RSVPs of three, all past, elsewhere.
    const day = 24 * 3600_000
    for (let i = 1; i <= 6; i++) {
      const past = await room(i <= 2 ? venue.id : null)
      const at = new Date(Date.now() - i * day)
      await db.events.update({ where: { id: past.eventId }, data: { start_time: new Date(at.getTime() - 3600_000), end_time: at } })
      await putInRoom({ ...past, userId: regular, at })
      if (i >= 3 && i <= 5) {
        await db.event_rsvps.create({ data: { event_id: past.eventId, user_id: keen, status: "going" } })
        await putInRoom({ ...past, userId: keen, at })
      }
    }
    await arrive(r, me)
    await arrive(r, regular)
    await arrive(r, keen)
    await fill(r, 5) // seven others

    const small = (await matchesForEvent(r.eventId, me))!
    expect(cardOf(small, regular).badges).toEqual([])

    await fill(r, 1) // eight others
    const cards = (await matchesForEvent(r.eventId, me))!
    expect(cardOf(cards, regular).badges.map((b) => b.label)).toEqual(["Regular here", "5+ nights this month"])
    expect(cardOf(cards, keen).badges.map((b) => b.kind)).toEqual(["shows_up"])

    await db.profiles.update({ where: { id: keen }, data: { shows_up_badge: false } })
    expect(cardOf((await matchesForEvent(r.eventId, me))!, keen).badges).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* The profile fields and this-or-that, through the routes                    */
/* -------------------------------------------------------------------------- */

type Who = { id: string; token: string }
async function who(label: string): Promise<Who> {
  const id = await adult(label)
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}
async function call(handler: unknown, path: string, as: Who, opts: { method?: string; body?: unknown; params?: object } = {}) {
  const res = await (handler as (r: NextRequest, c: { params: Promise<unknown> }) => Promise<Response>)(
    new NextRequest(`http://localhost${path}`, {
      method: opts.method ?? "GET",
      headers: { authorization: `Bearer ${as.token}`, "content-type": "application/json" },
      ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
    }),
    { params: Promise.resolve(opts.params ?? {}) }
  )
  return { status: res.status, body: await res.json() }
}
const put = (as: Who, body: object) =>
  call(profileRoute.PUT, `/api/mobile/profiles/${as.id}`, as, { method: "PUT", body, params: { userId: as.id } })

describe("the about-you fields on the profile (MV-I05)", () => {
  it("stores the picks, refuses a sign without its calendar, and shows them only to who may see", async () => {
    const me = await who("mv-p-me")
    await db.profiles.update({ where: { id: me.id }, data: { date_of_birth: new Date("1996-08-01T00:00:00Z") } })

    expect((await put(me, { sun_sign: "leo" })).status).toBe(400)
    expect((await put(me, { languages: ["klingon"] })).status).toBe(400)
    const saved = await put(me, {
      languages: ["malayalam", "kannada_learning"],
      home_state: "kerala",
      sun_sign: "leo",
      sign_system: "rashi",
      shows_up_badge: true,
    })
    expect(saved.status).toBe(200)
    expect(
      await db.profiles.findUnique({
        where: { id: me.id },
        select: { languages: true, home_state: true, sun_sign: true, sign_system: true, shows_up_badge: true },
      })
    ).toEqual({ languages: ["malayalam", "kannada_learning"], home_state: "kerala", sun_sign: "leo", sign_system: "rashi", shows_up_badge: true })

    const self = await call(profileRoute.GET, `/api/mobile/profiles/${me.id}`, me, { params: { userId: me.id } })
    expect(self.body.data.profile).toMatchObject({ sun_sign: "leo", sign_system: "rashi", suggested_sun_sign: "leo" })
    expect(self.body.data.profile.date_of_birth).toBeUndefined()

    // A stranger who cannot see who this is gets none of it, on either route.
    const stranger = await who("mv-p-stranger")
    const asStranger = await call(profileRoute.GET, `/api/mobile/profiles/${me.id}`, stranger, { params: { userId: me.id } })
    expect(asStranger.status).toBe(200)
    for (const k of ["languages", "home_state", "sun_sign", "sign_system", "sign", "suggested_sun_sign"]) {
      expect(asStranger.body.data.profile).not.toHaveProperty(k)
    }
    const user = await call(userRoute.GET, `/api/mobile/users/${me.id}`, stranger, { params: { userId: me.id } })
    for (const k of ["languages", "homeState", "sign"]) expect(user.body.data).not.toHaveProperty(k)

    // Off again: both null.
    expect((await put(me, { sun_sign: null, sign_system: null })).status).toBe(200)
    expect(await db.profiles.findUnique({ where: { id: me.id }, select: { sun_sign: true, sign_system: true } })).toEqual({
      sun_sign: null,
      sign_system: null,
    })
  })

  it("the table holds a sign and its calendar together (profiles_sign_shape)", async () => {
    const id = await adult("mv-p-check")
    await expect(db.$executeRaw`UPDATE profiles SET sun_sign = 'leo' WHERE id = ${id}`).rejects.toThrow(/profiles_sign_shape|23514/)
    await expect(
      db.$executeRaw`UPDATE profiles SET sun_sign = 'leo', sign_system = 'vedic' WHERE id = ${id}`
    ).rejects.toThrow(/profiles_sign_shape|23514/)
  })
})

describe("this-or-that answers (MV-I06)", () => {
  it("sets, takes back, and refuses the whole request on an unknown question", async () => {
    const me = await who("mv-t-me")
    const path = "/api/mobile/me/this-or-that"
    const set = await call(thisOrThatRoute.PUT, path, me, { method: "PUT", body: { answers: { coffee_or_chai: "b", metro_or_auto: "a" } } })
    expect(set.status).toBe(200)
    expect(set.body.data.answers).toEqual({ coffee_or_chai: "b", metro_or_auto: "a" })

    const bad = await call(thisOrThatRoute.PUT, path, me, { method: "PUT", body: { answers: { metro_or_auto: "b", veg_or_nonveg: "a" } } })
    expect(bad.status).toBe(400)
    const choiceBad = await call(thisOrThatRoute.PUT, path, me, { method: "PUT", body: { answers: { metro_or_auto: "c" } } })
    expect(choiceBad.status).toBe(400)

    const back = await call(thisOrThatRoute.PUT, path, me, { method: "PUT", body: { answers: { coffee_or_chai: null } } })
    expect(back.body.data.answers).toEqual({ metro_or_auto: "a" })
    expect(await db.this_or_that_answers.findMany({ where: { user_id: me.id }, select: { question: true, choice: true } })).toEqual([
      { question: "metro_or_auto", choice: "a" },
    ])
    expect((await call(thisOrThatRoute.GET, path, me)).body.data.answers).toEqual({ metro_or_auto: "a" })
  })

  it("serves the vocabulary", async () => {
    const me = await who("mv-o-me")
    const res = await call(optionsRoute.GET, "/api/mobile/profile-options", me)
    expect(res.status).toBe(200)
    expect(res.body.data.thisOrThat).toHaveLength(12)
    expect(res.body.data.signs).toContainEqual({ slug: "leo", western: "Leo", rashi: "Simha", symbol: "♌" })
    expect(res.body.data.maxLanguages).toBe(5)
  })
})
