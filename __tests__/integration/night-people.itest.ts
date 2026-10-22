import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "itest-nextauth-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { conversationPair } from "@/lib/conversations"
import { SYSTEM_USER_ID } from "@/lib/event-kind"
import { signAccessToken } from "@/lib/mobile-auth"
import { roomHandle } from "@/lib/room-handle"

import { cleanup, closeDb, db, makeUser, onboard, testId } from "./helpers"

/**
 * People from a night you attended (Flow 4 · 4.5, SV6), through the real
 * route on a real database.
 *
 * The deck outlives the room, so every privacy rule is pinned here: handles,
 * never ids; pseudonyms unless the room names them; blocks either way, closed
 * pairs and friends never; the people the room hides stay hidden; and a
 * concert-sized night pages by cursor with a total.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const peopleRoute = require("@/app/api/mobile/events/[eventId]/people/route") as typeof import("@/app/api/mobile/events/[eventId]/people/route")
const matchesRoute = require("@/app/api/mobile/events/[eventId]/matches/route") as typeof import("@/app/api/mobile/events/[eventId]/matches/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
const venues: string[] = []

afterAll(async () => {
  await db.event_likes.deleteMany({ where: { event_id: { in: events } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.blocked_users.deleteMany({ where: { OR: [{ blocker_id: { in: users } }, { blocked_id: { in: users } }] } })
  await db.friendships.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await cleanup(users, events)
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await closeDb()
})

async function person(label = "np") {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

/** A night that ended `endedMinAgo` minutes ago, with its room. */
async function night(endedMinAgo = 60, kind: "event" | "venue_day" = "event") {
  const host = kind === "event" ? await makeUser(testId("np_host"), "organizer") : SYSTEM_USER_ID
  if (kind === "event") users.push(host)
  const end = new Date(Date.now() - endedMinAgo * 60_000)
  const start = new Date(end.getTime() - 4 * 3_600_000)
  const venueId =
    kind === "venue_day"
      ? (await db.venues.create({ data: { name: testId("np_venue"), city: "Bengaluru", timezone: "UTC", day_reset_hour: 6 } })).id
      : null
  if (venueId) venues.push(venueId)
  const e = await db.events.create({
    data: {
      slug: testId("np"),
      title: "Neon Nights",
      description: "integration fixture",
      start_time: start,
      end_time: end,
      timezone: "UTC",
      status: "published",
      visibility: kind === "event" ? "public" : "unlisted",
      kind,
      organizer_id: host,
      venue_id: venueId,
      venue_name: venueId ? "Toit" : null,
    },
  })
  events.push(e.id)
  const occurrence = await db.event_occurrences.create({
    data: { event_id: e.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: end },
  })
  const room = await db.chat_groups.create({ data: { event_id: e.id, name: "Neon Nights Chat", status: "active", member_count: 0 } })
  return { id: e.id, occurrenceId: occurrence.id, roomId: room.id }
}

type Night = Awaited<ReturnType<typeof night>>
let arrivals = 0

/** Somebody who was there, with a pseudonym; arrival order is the deck's order. */
async function wasThere(n: Night, who: { id: string }, opts: { kind?: "attendee" | "staff"; inside?: boolean; banned?: boolean } = {}) {
  arrivals += 1
  await db.event_check_ins.create({
    data: {
      event_id: n.id,
      occurrence_id: n.occurrenceId,
      user_id: who.id,
      kind: opts.kind ?? "attendee",
      status: opts.inside ? "checked_in" : "checked_out",
      check_in_time: new Date(Date.now() - 3 * 3_600_000 + arrivals * 1000),
    },
  })
  await db.chat_group_members.create({
    data: { chat_group_id: n.roomId, user_id: who.id, anonymous_name: `Pseudo ${arrivals}`, status: opts.banned ? "banned" : "active", ...(opts.banned && { banned_by: "itest-host" }) },
  })
}

async function people(eventId: string, token: string, query = "") {
  const res = await peopleRoute.GET(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}/people${query}`, { headers: { authorization: `Bearer ${token}` } }),
    { params: Promise.resolve({ eventId }) }
  )
  return { status: res.status, text: await res.clone().text(), json: await res.json() }
}

type Card = { userId: string; displayName: string; photo: string | null; insideNow: boolean; youLiked: boolean; overlap: string | null }
const handles = (n: Night, ...who: { id: string }[]) => who.map((w) => roomHandle(n.id, w.id))

describe("GET /events/:id/people — who may ask", () => {
  it("is for people who were there", async () => {
    const n = await night()
    const outsider = await person()
    expect((await people(n.id, outsider.token)).status).toBe(403)
    expect((await people("00000000-0000-4000-8000-000000000000", outsider.token)).status).toBe(404)
  })

  it("has no deck for a venue's live room", async () => {
    const day = await night(60, "venue_day")
    const me = await person()
    await wasThere(day, me)
    expect((await people(day.id, me.token)).status).toBe(404)
  })
})

describe("GET /events/:id/people — a member the room banned", () => {
  const deck = async (eventId: string, token: string) => {
    const res = await matchesRoute.GET(
      new NextRequest(`http://localhost/api/mobile/events/${eventId}/matches`, { headers: { authorization: `Bearer ${token}` } }),
      { params: Promise.resolve({ eventId }) }
    )
    return { status: res.status, json: await res.json() }
  }

  it("refuses them as the chat does, and the match deck too; lifted, both open again", async () => {
    const n = await night()
    const me = await person()
    const other = await person()
    await wasThere(n, me, { banned: true })
    await wasThere(n, other)

    const refused = { success: false, error: "The organiser has removed you from this room.", errorCode: "USER_BANNED" }
    const people403 = await people(n.id, me.token)
    expect(people403.status).toBe(403)
    expect(people403.json).toMatchObject(refused)
    const deck403 = await deck(n.id, me.token)
    expect(deck403.status).toBe(403)
    expect(deck403.json).toMatchObject(refused)

    await db.chat_group_members.updateMany({ where: { chat_group_id: n.roomId, user_id: me.id }, data: { status: "active", banned_by: null } })
    const lifted = await people(n.id, me.token)
    expect(lifted.status).toBe(200)
    expect((lifted.json.data.people as Card[]).map((c) => c.userId)).toEqual(handles(n, other))
    expect((await deck(n.id, me.token)).status).toBe(200)
  })

  it("counts only a host's ban: a suspended-then-reinstated person is listed and may look (M2)", async () => {
    const n = await night()
    const me = await person()
    const back = await person()
    await wasThere(n, me)
    await wasThere(n, back)
    // What a suspension leaves behind once lifted: banned, by nobody.
    await db.chat_group_members.updateMany({ where: { chat_group_id: n.roomId, user_id: back.id }, data: { status: "banned", banned_by: null } })

    expect(((await people(n.id, me.token)).json.data.people as Card[]).map((c) => c.userId)).toEqual(handles(n, back))
    expect((await people(n.id, back.token)).status).toBe(200)
  })

  it("lets in somebody who checked in and never joined the room: attendance is the door", async () => {
    const n = await night()
    const me = await person()
    const other = await person()
    await db.event_check_ins.create({
      data: { event_id: n.id, occurrence_id: n.occurrenceId, user_id: me.id, status: "checked_out", check_in_time: new Date(Date.now() - 3 * 3_600_000) },
    })
    await wasThere(n, other)

    const res = await people(n.id, me.token)
    expect(res.status).toBe(200)
    expect((res.json.data.people as Card[]).map((c) => c.userId)).toEqual(handles(n, other))
  })
})

describe("GET /events/:id/people — as the room shows them", () => {
  it("handles, never ids; the pseudonym unless they revealed here; nobody the room hides", async () => {
    const n = await night()
    const me = await person()
    const anon = await person()
    const shown = await person()
    const still = await person()
    const iBlocked = await person()
    const blockedMe = await person()
    const closedPair = await person()
    const friendOpen = await person()
    const friendHidden = await person()
    const offline = await person()
    const staff = await person()
    const banned = await person()
    const suspended = await person()
    const deleted = await person()
    for (const p of [me, anon, shown, iBlocked, blockedMe, closedPair, friendOpen, friendHidden, offline, suspended, deleted]) await wasThere(n, p)
    await wasThere(n, still, { inside: true })
    await wasThere(n, staff, { kind: "staff" })
    await wasThere(n, banned, { banned: true })

    await db.profiles.update({ where: { id: shown.id }, data: { photos: ["shown.jpg"] } })
    await db.event_match_preferences.create({ data: { event_id: n.id, user_id: shown.id, revealed: true } })
    await db.blocked_users.create({ data: { blocker_id: me.id, blocked_id: iBlocked.id } })
    await db.blocked_users.create({ data: { blocker_id: blockedMe.id, blocked_id: me.id } })
    const [c1, c2] = conversationPair(me.id, closedPair.id)
    await db.private_conversations.create({ data: { user1_id: c1, user2_id: c2, closed_at: new Date() } })
    // Friends, whichever way they set "friends can see me in rooms": never a stranger card, never named here.
    for (const [f, sees] of [[friendOpen, true], [friendHidden, false]] as const) {
      const [a, b] = conversationPair(me.id, f.id)
      await db.friendships.create({ data: { user1_id: a, user2_id: b } })
      await db.profiles.update({ where: { id: f.id }, data: { friends_see_me_in_rooms: sees } })
    }
    await db.profiles.update({ where: { id: offline.id }, data: { show_online: false } })
    await db.user.update({ where: { id: suspended.id }, data: { suspended_at: new Date() } })
    await db.user.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } })
    await db.event_likes.create({ data: { event_id: n.id, liker_id: me.id, liked_id: anon.id } })

    const { status, text, json } = await people(n.id, me.token)

    expect(status).toBe(200)
    expect(json.data).toMatchObject({ open: true, total: 3, nextCursor: null })
    const cards = json.data.people as Card[]
    expect(cards.map((c) => c.userId)).toEqual(handles(n, anon, shown, still))
    const pseudonymOf = async (u: { id: string }) =>
      (await db.chat_group_members.findFirstOrThrow({ where: { chat_group_id: n.roomId, user_id: u.id } })).anonymous_name
    expect(cards[0]).toEqual({
      userId: roomHandle(n.id, anon.id),
      displayName: await pseudonymOf(anon),
      photo: null,
      age: null,
      insideNow: false,
      youLiked: true,
      overlap: null,
    })
    // Revealed here: the roster's rule names them, with their photo.
    const shownName = (await db.user.findUniqueOrThrow({ where: { id: shown.id } })).name
    expect(cards[1]).toMatchObject({ displayName: shownName, photo: "shown.jpg" })
    expect(cards[2]).toMatchObject({ displayName: await pseudonymOf(still), photo: null, insideNow: true, youLiked: false })

    // No account id anywhere in the body — not even of somebody left out.
    for (const u of [me, anon, shown, still, iBlocked, blockedMe, closedPair, friendOpen, friendHidden, offline, staff, banned, suspended, deleted]) {
      expect(text).not.toContain(u.id)
    }
  })

  it("leaves a friend out of their friend's deck both ways", async () => {
    const n = await night()
    const a = await person()
    const b = await person()
    const other = await person()
    for (const p of [a, b, other]) await wasThere(n, p)
    const [u1, u2] = conversationPair(a.id, b.id)
    await db.friendships.create({ data: { user1_id: u1, user2_id: u2 } })

    expect(((await people(n.id, a.token)).json.data.people as Card[]).map((c) => c.userId)).toEqual(handles(n, other))
    expect(((await people(n.id, b.token)).json.data.people as Card[]).map((c) => c.userId)).toEqual(handles(n, other))
    // A stranger still sees both.
    expect(((await people(n.id, other.token)).json.data.people as Card[]).map((c) => c.userId)).toEqual(handles(n, a, b))
  })
})

describe("GET /events/:id/people — a concert-sized night", () => {
  it("pages by cursor with the total, every person once", async () => {
    const n = await night()
    const me = await person()
    await wasThere(n, me)
    const crowd = []
    for (let i = 0; i < 7; i++) {
      const p = await person()
      await wasThere(n, p)
      crowd.push(p)
    }

    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const { json }: { json: { data: { total: number; people: Card[]; nextCursor: string | null } } } = await people(
        n.id,
        me.token,
        `?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
      )
      expect(json.data.total).toBe(7)
      seen.push(...json.data.people.map((c) => c.userId))
      cursor = json.data.nextCursor
      pages += 1
    } while (cursor && pages < 10)

    expect(pages).toBe(3)
    expect(seen).toEqual(handles(n, ...crowd))
  })

  it("refuses a cursor that is not a card from this room", async () => {
    const n = await night()
    const elsewhere = await night()
    const me = await person()
    const them = await person()
    await wasThere(n, me)
    await wasThere(n, them)

    // A card this viewer may not see is no cursor either (L1): somebody they blocked.
    const blocked = await person()
    await wasThere(n, blocked)
    await db.blocked_users.create({ data: { blocker_id: me.id, blocked_id: blocked.id } })
    for (const cursor of [them.id, roomHandle(elsewhere.id, them.id), "rh_forged", roomHandle(n.id, blocked.id)]) {
      const res = await people(n.id, me.token, `?cursor=${encodeURIComponent(cursor)}`)
      expect(res.status).toBe(400)
      expect(res.json.errorCode).toBe("INVALID_CURSOR")
    }
  })
})

describe("GET /events/:id/people — the window", () => {
  it("is the count only once the room's chat has closed", async () => {
    const n = await night(25 * 60)
    const me = await person()
    const them = await person()
    await wasThere(n, me)
    await wasThere(n, them)

    const { status, json } = await people(n.id, me.token)
    expect(status).toBe(200)
    expect(json.data).toEqual({ open: false, total: 1, people: [], nextCursor: null })
  })
})

describe("GET /events/:id/people — one sentence of overlap", () => {
  async function room(size: number) {
    const n = await night()
    const me = await person()
    await wasThere(n, me)
    await db.this_or_that_answers.create({ data: { user_id: me.id, question: "coffee_or_chai", choice: "b" } })
    const twin = await person()
    await wasThere(n, twin)
    await db.this_or_that_answers.create({ data: { user_id: twin.id, question: "coffee_or_chai", choice: "b" } })
    for (let i = 2; i < size; i++) await wasThere(n, await person())
    return { n, me, twin }
  }

  it("names what they share in a night of eight or more", async () => {
    const { n, me, twin } = await room(8)
    const cards = (await people(n.id, me.token)).json.data.people as Card[]
    expect(cards.find((c) => c.userId === roomHandle(n.id, twin.id))?.overlap).toBe("You both picked chai over filter coffee")
    expect(cards.filter((c) => c.overlap !== null)).toHaveLength(1)
  })

  it("says nothing in a night under eight, where a line narrows who somebody is", async () => {
    const { n, me } = await room(7)
    const cards = (await people(n.id, me.token)).json.data.people as Card[]
    expect(cards.every((c) => c.overlap === null)).toBe(true)
  })
})
