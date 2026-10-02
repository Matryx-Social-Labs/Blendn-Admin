import { NextRequest } from "next/server"

import { signAccessToken } from "@/lib/mobile-auth"

import { cleanup, db, makeUser, onboard, testId } from "./helpers"

/**
 * The fixture world for the Go Live suites (step 4): people, venues with an
 * area at one point, real events at them, and the routes.
 *
 * Not a suite: `jest.integration.config.ts` only runs `*.itest.ts`.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
export const routes = {
  live: require("@/app/api/mobile/venues/[venueId]/live/route") as typeof import("@/app/api/mobile/venues/[venueId]/live/route"),
  venue: require("@/app/api/mobile/venues/[venueId]/route") as typeof import("@/app/api/mobile/venues/[venueId]/route"),
  checkin: require("@/app/api/mobile/events/[eventId]/checkin/route") as typeof import("@/app/api/mobile/events/[eventId]/checkin/route"),
  checkout: require("@/app/api/mobile/events/[eventId]/checkout/route") as typeof import("@/app/api/mobile/events/[eventId]/checkout/route"),
  event: require("@/app/api/mobile/events/[eventId]/route") as typeof import("@/app/api/mobile/events/[eventId]/route"),
  rsvp: require("@/app/api/mobile/events/[eventId]/rsvp/route") as typeof import("@/app/api/mobile/events/[eventId]/rsvp/route"),
  favorite: require("@/app/api/mobile/events/[eventId]/favorite/route") as typeof import("@/app/api/mobile/events/[eventId]/favorite/route"),
  interest: require("@/app/api/mobile/events/[eventId]/interest/route") as typeof import("@/app/api/mobile/events/[eventId]/interest/route"),
  rating: require("@/app/api/mobile/events/[eventId]/rating/route") as typeof import("@/app/api/mobile/events/[eventId]/rating/route"),
  peerRatings: require("@/app/api/mobile/events/[eventId]/peer-ratings/route") as typeof import("@/app/api/mobile/events/[eventId]/peer-ratings/route"),
  report: require("@/app/api/mobile/events/[eventId]/report/route") as typeof import("@/app/api/mobile/events/[eventId]/report/route"),
  presence: require("@/app/api/mobile/events/[eventId]/presence/route") as typeof import("@/app/api/mobile/events/[eventId]/presence/route"),
  eventChat: require("@/app/api/mobile/events/[eventId]/chat/route") as typeof import("@/app/api/mobile/events/[eventId]/chat/route"),
  roster: require("@/app/api/mobile/events/[eventId]/checkins/route") as typeof import("@/app/api/mobile/events/[eventId]/checkins/route"),
  waves: require("@/app/api/mobile/events/[eventId]/waves/route") as typeof import("@/app/api/mobile/events/[eventId]/waves/route"),
  matches: require("@/app/api/mobile/events/[eventId]/matches/route") as typeof import("@/app/api/mobile/events/[eventId]/matches/route"),
  messages: require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route"),
  groups: require("@/app/api/mobile/chat/groups/route") as typeof import("@/app/api/mobile/chat/groups/route"),
  activeCheckins: require("@/app/api/mobile/checkins/active/route") as typeof import("@/app/api/mobile/checkins/active/route"),
  attendance: require("@/app/api/mobile/me/attendance/route") as typeof import("@/app/api/mobile/me/attendance/route"),
  user: require("@/app/api/mobile/users/[userId]/route") as typeof import("@/app/api/mobile/users/[userId]/route"),
  account: require("@/app/api/mobile/account/route") as typeof import("@/app/api/mobile/account/route"),
}
/* eslint-enable @typescript-eslint/no-require-imports */

export const LAT = 12.9784
export const LNG = 77.6408
export const INSIDE = { latitude: LAT, longitude: LNG }
/** About 1.1 km north. */
export const OUTSIDE = { latitude: LAT + 0.01, longitude: LNG }
export const FENCE = { type: "circle", lat: LAT, lng: LNG, radius: 60, buffer: 20 }

export const world = { users: [] as string[], venues: [] as string[], orgs: [] as string[] }

export async function cleanupWorld() {
  const rows = await db.events.findMany({ where: { venue_id: { in: world.venues } }, select: { id: true } })
  const ids = rows.map((r) => r.id)
  await db.notifications.deleteMany({ where: { user_id: { in: world.users } } })
  await db.push_tokens.deleteMany({ where: { user_id: { in: world.users } } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: ids } } })
  await db.chat_messages.deleteMany({ where: { chat_group: { event_id: { in: ids } } } })
  await cleanup([], ids)
  await db.venues.deleteMany({ where: { id: { in: world.venues } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: world.orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: world.orgs } } })
  await cleanup(world.users, [])
}

export const yearsAgo = (years: number) => new Date(Date.now() - (years * 365.25 + 30) * 86_400_000)

/** An onboarded adult (30) unless told otherwise; `age: null` leaves the age unknown. */
export async function person(label = "gl", opts: { age?: number | null } = {}) {
  const id = await makeUser(testId(label))
  world.users.push(id)
  await onboard(id)
  const age = opts.age === undefined ? 30 : opts.age
  await db.profiles.update({ where: { id }, data: { date_of_birth: age === null ? null : yearsAgo(age), age: null } })
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

/**
 * A venue at the fixture point. Its day resets twelve hours from now unless a
 * test says otherwise, so no window is cut short by the reset at whatever hour
 * the suite runs.
 */
export async function venue(opts: { fence?: object | null; ownerOrg?: string; timezone?: string; resetHour?: number } = {}) {
  const row = await db.venues.create({
    data: {
      name: testId("Venue"),
      city: "Bengaluru",
      latitude: LAT,
      longitude: LNG,
      ...(opts.fence !== null && { geofence: opts.fence ?? FENCE }),
      ...(opts.ownerOrg && { owner_org_id: opts.ownerOrg, claimed_at: new Date(Date.now() - 86_400_000) }),
      timezone: opts.timezone ?? "UTC",
      day_reset_hour: opts.resetHour ?? (new Date().getUTCHours() + 12) % 24,
    },
  })
  world.venues.push(row.id)
  return row.id
}

/** A real event at the venue, on or starting in `startsInMin`, its area at the venue unless `far`. */
export async function realEvent(
  venueId: string,
  opts: {
    startsInMin: number
    visibility?: "public" | "private"
    link?: "auto_linked" | "confirmed" | "disputed" | null
    minAge?: number
    far?: boolean
    cancelled?: boolean
    hours?: number
  }
) {
  const host = await makeUser(testId("gl_host"), "organizer")
  world.users.push(host)
  const start = new Date(Date.now() + opts.startsInMin * 60_000)
  const end = new Date(start.getTime() + (opts.hours ?? 3) * 3_600_000)
  const lat = opts.far ? LAT + 0.01 : LAT
  const event = await db.events.create({
    data: {
      slug: testId("gl_evt"),
      title: testId("Jazz Night"),
      description: "integration fixture",
      start_time: start,
      end_time: end,
      timezone: "UTC",
      status: "published",
      visibility: opts.visibility ?? "public",
      organizer_id: host,
      venue_id: venueId,
      venue_link_status: opts.link === undefined ? null : opts.link,
      min_age: opts.minAge ?? null,
      latitude: lat,
      longitude: LNG,
      geofence: { ...FENCE, lat },
    },
  })
  await db.event_occurrences.create({
    data: {
      event_id: event.id,
      occurs_on: new Date(start.toISOString().slice(0, 10)),
      start_time: start,
      end_time: end,
      ...(opts.cancelled && { cancelled_at: new Date() }),
    },
  })
  return event.id
}

export const req = (url: string, token: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })

export async function goLive(token: string, venueId: string, body: object = { minutes: 20 }, at = INSIDE) {
  const res = await routes.live.POST(req(`/api/mobile/venues/${venueId}/live`, token, "POST", { ...at, ...body }), {
    params: Promise.resolve({ venueId }),
  })
  return { status: res.status, json: await res.json() }
}

export async function venueDetail(token: string, venueId: string) {
  const res = await routes.venue.GET(req(`/api/mobile/venues/${venueId}`, token), { params: Promise.resolve({ venueId }) })
  return { status: res.status, text: await res.text() }
}

export const eventParams = (eventId: string) => ({ params: Promise.resolve({ eventId }) })
export const groupParams = (chatGroupId: string) => ({ params: Promise.resolve({ chatGroupId }) })

/** Move a Go Live back in time by `minutes`: as if it had started that long ago. */
export async function rewind(eventId: string, userId: string, minutes: number) {
  await db.$executeRaw`
    UPDATE event_check_ins
       SET check_in_time = check_in_time - make_interval(mins => ${minutes}),
           created_at = created_at - make_interval(mins => ${minutes}),
           expires_at = expires_at - make_interval(mins => ${minutes}),
           stay_until = stay_until - make_interval(mins => ${minutes})
     WHERE event_id = ${eventId}::uuid AND user_id = ${userId}`
  await db.$executeRaw`
    UPDATE presence_sessions
       SET arrived_at = arrived_at - make_interval(mins => ${minutes}),
           last_seen_at = last_seen_at - make_interval(mins => ${minutes})
     WHERE event_id = ${eventId}::uuid AND user_id = ${userId}`
  await db.$executeRaw`
    UPDATE chat_group_members m
       SET last_allowed_at = last_allowed_at - make_interval(mins => ${minutes})
      FROM chat_groups g
     WHERE g.id = m.chat_group_id AND g.event_id = ${eventId}::uuid AND m.user_id = ${userId}`
}

export const checkInOf = (eventId: string, userId: string) =>
  db.event_check_ins.findFirstOrThrow({ where: { event_id: eventId, user_id: userId } })

export const sessionOf = (eventId: string, userId: string) =>
  db.presence_sessions.findFirstOrThrow({ where: { event_id: eventId, user_id: userId }, orderBy: { arrived_at: "desc" } })

/** Poll until `check` holds, rather than sleeping a guessed amount (the door's session write is not awaited). */
export async function until<T>(read: () => Promise<T>, check: (v: T) => boolean, timeoutMs = 3_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (check(value) || Date.now() - started > timeoutMs) return value
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** The person's open session on this day, once the door's write has landed. */
export const openSessionOf = (eventId: string, userId: string) =>
  until(
    () => db.presence_sessions.findFirst({ where: { event_id: eventId, user_id: userId, departed_at: null } }),
    (s) => s !== null
  )
