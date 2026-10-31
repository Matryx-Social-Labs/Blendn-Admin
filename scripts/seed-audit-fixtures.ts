import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import bcrypt from "bcryptjs"
import { syncOccurrences } from "../lib/occurrences"
import { realEventsWhere } from "../lib/event-kind"
import { openSession } from "../lib/presence-sessions"
import { checkKeywords } from "../lib/moderation/keyword-filter"
import { leaveOtherRooms } from "./seed-one-room"
import { createCrew, createCrewSchema, inviteToCrew, isRefusal, openInviteWhere } from "../lib/crews/crews"
import { requestFriend } from "../lib/friends"
import { areaSlug } from "../lib/venue-area"
import PHOTOS from "./seed-blr-photos.json"
import { cover, mirrorToTigris } from "./seed-media"
import { environmentRefusal } from "./test-accounts"

/**
 * The fixtures the 10-27 audit tickets cannot be driven without (SCRUM-208 log).
 *
 *   (a) two LIVE venue fences that overlap     Audit FX Overlap A / B, one point is inside both
 *   (b) an event that has just ended           Audit FX Just Ended, its room open with history
 *   (c) one city with more than 50 events      Mysuru, 55 published events
 *   (d) a room with one moderated message      Overlap A's room: written through the REAL send route
 *   (e) a live event with check-ins            Overlap A: five throwaways checked in
 *   (f) a night event, 01:30 and 23:30 IST     SCRUM-795: the phone's day is not the event's
 *   (g) a Hubballi event cluster               SCRUM-797: the nearest event starts last of 52
 *   (h) 5 tech + 3 coffee events, a driver     SCRUM-798: who likes both, tech first
 *   (i) a video-only event (no cover)          SCRUM-818
 *   (j) an unlisted event at a venue with area SCRUM-823
 *   (k) 54 open crew invites to the driver     SCRUM-835: 18 hosts x 3 crews, through createCrew
 *
 * `seed-blr-scenarios.ts` soft-deletes every other Bengaluru event, so these
 * are a sibling and touch nothing but their own rows.
 *
 * ## Tagged
 *
 * Events `audit-fx-*`, venues "Audit FX *", crews "Audit FX Crew *", accounts `qa.auditfx.N@blendn.app`.
 * `--clean --apply` removes exactly those and nothing else.
 *
 * ## The moderated message
 *
 * Posted to `POST /api/mobile/chat/groups/:id/messages` as a throwaway, with a
 * word in the keyword filter (`kamina`), so the route's own pre-save check hides
 * it and writes the flag. Nothing here writes `moderation_status` or
 * `moderation_flags`. Needs `API_BASE` (default staging-api for a staging
 * database, http://localhost:3000 for a local one) and `SEED_PASSWORD`.
 *
 * Run:
 *   DATABASE_URL=... npx tsx scripts/seed-audit-fixtures.ts                  # dry run
 *   DATABASE_URL=... RAILWAY_ENVIRONMENT_NAME=staging SEED_PASSWORD=... npx tsx scripts/seed-audit-fixtures.ts --apply
 *   DATABASE_URL=... RAILWAY_ENVIRONMENT_NAME=staging npx tsx scripts/seed-audit-fixtures.ts --clean --apply
 *
 * Idempotent: a re-run puts the times back to now, rebuilds the tagged rooms
 * and check-ins, and leaves everything else where it was. Staging or localhost
 * only (`environmentRefusal`).
 */

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })

const APPLY = process.argv.includes("--apply")
const CLEAN = process.argv.includes("--clean")

const SLUG = "audit-fx-"
const VENUE_PREFIX = "Audit FX "
const EMAIL = (n: number) => `qa.auditfx.${n}@blendn.app`
const SEED_PASSWORD = process.env.SEED_PASSWORD?.trim() ?? ""
const ORGANISER_EMAIL = "organizer@blendn.app"
const ADMIN_EMAIL = "admin@blendn.app"
/** A word in the keyword filter, mild enough to read aloud: the route hides it before anyone sees it. */
const BANNED_LINE = "you are such a kamina"

const MIN = 60_000
const HOUR = 60 * MIN
const NOW = new Date()
const TZ = "Asia/Kolkata"
const MYSURU_EVENTS = 55
const DAY = 24 * HOUR
const IST_OFFSET_MS = 330 * MIN
/** Tomorrow at h:m IST, whatever zone this machine runs in. */
const tomorrowIst = (h: number, m: number) => new Date((Math.floor((NOW.getTime() + IST_OFFSET_MS) / DAY) + 1) * DAY + h * HOUR + m * MIN - IST_OFFSET_MS)

const KORAMANGALA = { name: `${VENUE_PREFIX}Koramangala Hall`, lat: 12.9352, lng: 77.6245 }
/** 797: Hubballi. 51 events 2-3 km out over days 1-6, and the nearest one, at the centre, starting last (day 6.5). */
const HUBBALLI = { city: "Hubballi", state: "Karnataka", lat: 15.3647, lng: 75.124 }
const RING_EVENTS = 51
/** 798: tech leads (created first, most events), coffee follows. */
const INTERESTS = [
  { slug: "tech-meetups", label: "Tech Meetup", events: 5 },
  { slug: "food-drink-coffee", label: "Coffee Morning", events: 3 },
]
/** 835: crews are capped at 3 owned per person, so 54 open invites to one account take 18 hosts. */
const CREW_HOSTS = 18
const CREWS_PER_HOST = 3

const circle = (lat: number, lng: number, radius: number) => ({ type: "circle" as const, lat, lng, radius, buffer: 20 })

/** Two circles 70 m apart with 60 m radii: 50 m of overlap, and the midpoint is inside both. */
const OVERLAP = {
  a: { name: `${VENUE_PREFIX}Overlap A`, lat: 12.95075, lng: 77.58475, fence: circle(12.95075, 77.58475, 60) },
  b: { name: `${VENUE_PREFIX}Overlap B`, lat: 12.95075, lng: 77.58538, fence: circle(12.95075, 77.58538, 60) },
  point: { lat: 12.95075, lng: 77.585065 },
}
const HALL = { name: `${VENUE_PREFIX}Hall`, lat: 12.9611, lng: 77.601, fence: circle(12.9611, 77.601, 50) }
const INDIRANAGAR = { name: `${VENUE_PREFIX}Indiranagar Hall`, lat: 12.9784, lng: 77.6408, fence: circle(12.9784, 77.6408, 50), area: "Indiranagar" }
const MYSURU = { city: "Mysuru", state: "Karnataka", lat: 12.2958, lng: 76.6394 }

const PEOPLE = ["Aditi Verma", "Rohan Pillai", "Meera Nair", "Kabir Sethi", "Tara Menon"]
/** Account 6 holds the interests (798) and the crew invites (835); accounts 7.. host the crews. */
const DRIVER = { n: PEOPLE.length + 1, name: "Audit Driver" }
const HOSTS = Array.from({ length: CREW_HOSTS }, (_, i) => ({ n: DRIVER.n + 1 + i, name: `Audit Host ${String(i + 1).padStart(2, "0")}` }))
const CREW_NAME = (host: number, k: number) => `Audit FX Crew ${String(host * CREWS_PER_HOST + k + 1).padStart(2, "0")}`
const ANIMALS = ["Otter", "Fox", "Heron", "Lynx", "Finch"]
const HISTORY = [
  "Hey all, anyone near the front?",
  "Just got here, the queue was short.",
  "Is the first talk starting on time?",
  "Grabbed a table by the window if anyone wants it.",
  "That opening set was great.",
  "Where is everyone sitting for the panel?",
  "The coffee at the back is good.",
  "Anyone staying for the after-session?",
  "Loved the closing words.",
  "Thanks everyone, see you at the next one.",
]

const hostOf = (url: string | undefined) => {
  try {
    return new URL(url ?? "").hostname
  } catch {
    return ""
  }
}
const LOCAL = new Set(["localhost", "127.0.0.1"])
/** Staging's API for a staging database, a local server for a local one; nothing else is ever written to. */
function apiBase(): string {
  const given = process.env.API_BASE?.trim()
  const base = given || (LOCAL.has(hostOf(process.env.DATABASE_URL)) ? "http://localhost:3000" : "https://staging-api.blendn.app")
  if (!LOCAL.has(hostOf(base)) && hostOf(base) !== "staging-api.blendn.app") throw new Error(`API_BASE ${base} is neither staging nor local`)
  return base.replace(/\/$/, "")
}

async function clean() {
  const events = await db.events.findMany({ where: { slug: { startsWith: SLUG }, ...realEventsWhere }, select: { id: true } })
  const users = await db.user.findMany({ where: { email: { startsWith: "qa.auditfx.", endsWith: "@blendn.app" } }, select: { id: true } })
  const userIds = users.map((u) => u.id)
  const venues = await db.venues.findMany({ where: { name: { startsWith: VENUE_PREFIX } }, select: { id: true } })
  const crewIds = (await db.crews.findMany({ where: { created_by: { in: userIds } }, select: { id: true } })).map((c) => c.id)
  console.log(`tagged rows: ${events.length} events, ${users.length} accounts, ${venues.length} venues, ${crewIds.length} crews`)
  if (!APPLY) return console.log("\nDry run. Re-run with --clean --apply to delete them.\n")
  const eventIds = events.map((e) => e.id)
  await db.presence_sessions.deleteMany({ where: { event_id: { in: eventIds } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: eventIds } } })
  await db.chat_groups.deleteMany({ where: { OR: [{ event_id: { in: eventIds } }, { crew_id: { in: crewIds } }] } })
  await db.crew_invites.deleteMany({ where: { OR: [{ crew_id: { in: crewIds } }, { invited_user_id: { in: userIds } }] } })
  await db.crew_members.deleteMany({ where: { OR: [{ crew_id: { in: crewIds } }, { user_id: { in: userIds } }] } })
  await db.crews.deleteMany({ where: { id: { in: crewIds } } })
  await db.events.deleteMany({ where: { id: { in: eventIds }, ...realEventsWhere } })
  await db.venues.deleteMany({ where: { id: { in: venues.map((v) => v.id) } } })
  await db.user.deleteMany({ where: { id: { in: userIds } } })
  console.log("deleted.")
}

function plan() {
  const { a, b, point } = OVERLAP
  console.log("Plan (times are offsets from the moment of the run):")
  console.log(`  (a) ${a.name} and ${b.name}: circles of 60 m, 70 m apart; inside both at ${point.lat}, ${point.lng}`)
  console.log("      two events live now, one at each")
  console.log(`  (e) 5 throwaways (${EMAIL(1)} .. ${EMAIL(5)}) checked in to Overlap A, room open`)
  console.log(`  (d) one message by ${EMAIL(5)} through POST /chat/groups/:id/messages (${apiBase()}), hidden by the keyword filter`)
  console.log(`  (b) "Audit FX Just Ended" at ${HALL.name}: ended 40 min ago, room open (writable 24 h), ${HISTORY.length} lines, 4 checked out`)
  console.log(`  (c) ${MYSURU_EVENTS} published events in ${MYSURU.city}, one a day-ish over the next 30 days`)
  console.log(`  (f) 795: events at 01:30 and 23:30 IST tomorrow, Koramangala`)
  console.log(`  (g) 797: ${RING_EVENTS} events 2-3 km round ${HUBBALLI.city} over days 1-6, and the nearest one at the centre on day 6.5`)
  console.log(`  (h) 798: ${EMAIL(DRIVER.n)} likes ${INTERESTS.map((i) => `${i.slug} (${i.events} events)`).join(" then ")}`)
  console.log("  (i) 818: a video-only event, no cover; (j) 823: an unlisted event at an Indiranagar venue with an area")
  console.log(`  (k) 835: ${CREW_HOSTS * CREWS_PER_HOST} crews by ${CREW_HOSTS} hosts, each inviting ${EMAIL(DRIVER.n)}, through createCrew`)
  console.log(`  checks: ${SEED_PASSWORD ? "SEED_PASSWORD set" : "SEED_PASSWORD missing (needed for --apply)"}; keyword filter hides the line: ${checkKeywords(BANNED_LINE)?.action === "hide"}`)
}

async function ensureAccounts(accounts: { n: number; name: string }[]): Promise<string[]> {
  const hashed = await bcrypt.hash(SEED_PASSWORD, 12)
  const ids: string[] = []
  for (const { n, name } of accounts) {
    const age = 27 + ((n - 1) % 10)
    const user = await db.user.upsert({
      where: { email: EMAIL(n) },
      update: { password: hashed, role: "attendee", deletedAt: null, suspended_at: null, name },
      create: { email: EMAIL(n), name, password: hashed, role: "attendee", emailVerified: new Date() },
    })
    await db.profiles.upsert({
      where: { id: user.id },
      update: { name, age, onboarded: true },
      create: { id: user.id, name, age, onboarded: true },
    })
    ids.push(user.id)
  }
  return ids
}

async function ensureVenue(v: { name: string; lat: number; lng: number; fence: object; area?: string }, createdBy: string) {
  const data = {
    name: v.name,
    address: `${v.name}, Bengaluru 560001`,
    city: "Bengaluru",
    latitude: v.lat,
    longitude: v.lng,
    capacity: 200,
    venue_type: "cafe" as const,
    geofence: v.fence,
    status: "active" as const,
    deleted_at: null,
    timezone: TZ,
    ...(v.area && { area: v.area, area_slug: areaSlug(v.area) }),
  }
  const existing = await db.venues.findFirst({ where: { name: v.name, city: "Bengaluru" }, select: { id: true } })
  return existing ? db.venues.update({ where: { id: existing.id }, data }) : db.venues.create({ data: { ...data, created_by: createdBy } })
}

interface EventArgs {
  slug: string
  title: string
  start: Date
  end: Date
  place: { name: string; lat: number; lng: number; fence?: object }
  city: string
  state: string
  venueId: string | null
  organiserId: string
  orgId: string | null
  /** No cover image (818). */
  coverless?: boolean
  /** Not on any list; reached by its link (823). */
  unlisted?: boolean
}
async function upsertEvent(e: EventArgs) {
  const fields = {
    title: e.title,
    description: `${e.title}: a fixture event for the 10-27 audit drives (tagged audit-fx).`,
    short_description: "Audit fixture",
    latitude: e.place.lat,
    longitude: e.place.lng,
    address: `${e.place.name}, ${e.city}`,
    venue_name: e.place.name,
    venue_id: e.venueId,
    venue_link_status: e.venueId ? ("confirmed" as const) : null,
    city: e.city,
    state: e.state,
    country: "India",
    start_time: e.start,
    end_time: e.end,
    timezone: TZ,
    status: "published" as const,
    visibility: e.unlisted ? ("unlisted" as const) : ("public" as const),
    max_capacity: 200,
    door_policy: "open" as const,
    deleted_at: null,
    organizer_id: e.organiserId,
    organizer_org_id: e.orgId,
    cover_image_url: e.coverless ? null : cover(e.slug),
    check_in_radius: 150,
    geofence: e.place.fence ?? { type: "circle", lat: e.place.lat, lng: e.place.lng, radius: 100, buffer: 30 },
    pre_suspension_status: null,
  }
  const event = await db.events.upsert({ where: { slug: e.slug }, update: fields, create: { slug: e.slug, ...fields } })
  await db.event_occurrences.updateMany({ where: { event_id: event.id }, data: { cancelled_at: null } })
  await syncOccurrences(event.id, e.start, e.end, TZ)
  return event
}

/** A room with its members and, when given, its lines; replaces the event's tagged room. */
async function rebuildRoom(eventId: string, title: string, memberIds: string[], organiserId: string, lines: string[], lastAt: Date) {
  await db.chat_groups.deleteMany({ where: { event_id: eventId } })
  const room = await db.chat_groups.create({
    data: { event_id: eventId, type: "event", name: title, description: `The room for ${title}.`, rules: "Be kind.", status: "active", member_count: memberIds.length + 1 },
  })
  for (const [i, user_id] of memberIds.entries()) {
    await db.chat_group_members.create({ data: { chat_group_id: room.id, user_id, anonymous_name: `Audit ${ANIMALS[i % ANIMALS.length]} ${i + 1}`, status: "active" } })
  }
  await db.chat_group_members.create({ data: { chat_group_id: room.id, user_id: organiserId, role: "admin", status: "active" } })
  for (const [i, content] of lines.entries()) {
    const at = new Date(lastAt.getTime() - (lines.length - i) * 4 * MIN)
    await db.chat_messages.create({
      data: { chat_group_id: room.id, user_id: memberIds[i % memberIds.length], content, type: "text", moderation_status: "clean", created_at: at, updated_at: at },
    })
  }
  await db.chat_groups.update({ where: { id: room.id }, data: { last_message_at: lines.length ? lastAt : null } })
  return room.id
}

async function checkIn(eventId: string, userId: string, at: Date, place: { lat: number; lng: number }, out?: Date) {
  const occ = await db.event_occurrences.findFirstOrThrow({ where: { event_id: eventId, cancelled_at: null }, orderBy: { start_time: "asc" } })
  await db.event_check_ins.deleteMany({ where: { event_id: eventId, user_id: userId } })
  await db.presence_sessions.deleteMany({ where: { event_id: eventId, user_id: userId } })
  if (!out) await leaveOtherRooms(db, userId, occ.id, at)
  await db.event_check_ins.create({
    data: {
      event_id: eventId,
      occurrence_id: occ.id,
      user_id: userId,
      kind: "attendee",
      status: out ? "checked_out" : "checked_in",
      check_in_time: at,
      ...(out && { check_out_time: out }),
      latitude: place.lat,
      longitude: place.lng,
      device_info: { platform: "ios", source: "seed-audit-fixtures" },
      last_seen_at: out ?? new Date(),
    },
  })
  const session = await openSession({ eventId, occurrenceId: occ.id, userId, at, source: "polling" })
  await db.presence_sessions.update({
    where: { id: session.id },
    data: out ? { departed_at: out, departed_source: "user", last_seen_at: out } : { last_seen_at: new Date() },
  })
}

/** The REAL send route, as a throwaway signed in with the seed password. Returns the route's own verdict. */
async function sendThroughTheRoute(email: string, roomId: string, content: string): Promise<{ status: number; hidden: boolean }> {
  const base = apiBase()
  const signin = await fetch(`${base}/api/mobile/auth/signin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: SEED_PASSWORD }),
  })
  const token = (await signin.json().catch(() => null))?.data?.accessToken
  if (!signin.ok || !token) throw new Error(`sign-in as ${email} answered ${signin.status}; is ${base} up, and is this the seed password?`)
  const sent = await fetch(`${base}/api/mobile/chat/groups/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ content, type: "text" }),
  })
  const body = await sent.json().catch(() => null)
  return { status: sent.status, hidden: body?.data?.moderation_hidden === true }
}

type Base = Pick<EventArgs, "state" | "organiserId" | "orgId" | "city">
const endOf = (start: Date) => new Date(start.getTime() + 3 * HOUR)

/** 795: sessions at 01:30 and 23:30 IST tomorrow, where a Toronto phone and the event are on different days. */
async function lateNightEvents(base: Base) {
  const events = []
  for (const [slug, title, h, m] of [["late-night", "Audit FX Late Night", 1, 30], ["late-evening", "Audit FX Late Evening", 23, 30]] as const) {
    const start = tomorrowIst(h, m)
    events.push(await upsertEvent({ ...base, slug: SLUG + slug, title, start, end: endOf(start), place: KORAMANGALA, venueId: null }))
  }
  return events
}

/** 797: a ring of 51 events over days 1-6 and the nearest one, at the centre, starting last: it falls past the 50 soonest. */
async function nearbyCluster(base: Omit<Base, "city" | "state">) {
  const where = { city: HUBBALLI.city, state: HUBBALLI.state }
  const at = (lat: number, lng: number) => ({ name: `${VENUE_PREFIX}Hubballi Hall`, lat, lng })
  for (let i = 0; i < RING_EVENTS; i++) {
    const angle = (2 * Math.PI * i) / RING_EVENTS
    const start = new Date(NOW.getTime() + (1 + Math.floor((i * 5) / RING_EVENTS)) * DAY + (i % 6) * HOUR)
    const place = at(HUBBALLI.lat + 0.025 * Math.sin(angle), HUBBALLI.lng + 0.025 * Math.cos(angle))
    await upsertEvent({ ...base, ...where, slug: `${SLUG}nearby-${String(i + 1).padStart(2, "0")}`, title: `Audit FX Hubballi Ring ${String(i + 1).padStart(2, "0")}`, start, end: endOf(start), place, venueId: null })
  }
  const last = new Date(NOW.getTime() + 6.5 * DAY)
  return upsertEvent({ ...base, ...where, slug: `${SLUG}nearby-nearest`, title: "Audit FX Hubballi Nearest", start: last, end: endOf(last), place: at(HUBBALLI.lat, HUBBALLI.lng), venueId: null })
}

/** 798: the driver likes tech (added first) and coffee; 5 tech and 3 coffee events are coming up in Bengaluru. */
async function interestEvents(base: Base, driverId: string) {
  const rows = await db.categories.findMany({ where: { slug: { in: INTERESTS.map((i) => i.slug) } }, select: { id: true, slug: true } })
  const idOf = (slug: string) => rows.find((r) => r.slug === slug)?.id
  if (rows.length !== INTERESTS.length) throw new Error("tech-meetups / food-drink-coffee categories are missing: run scripts/seed-categories.ts first")
  await db.user_interests.deleteMany({ where: { user_id: driverId } })
  const made: string[] = []
  for (const [k, it] of INTERESTS.entries()) {
    await db.user_interests.create({ data: { user_id: driverId, category_id: idOf(it.slug)!, created_at: new Date(NOW.getTime() - (INTERESTS.length - k) * HOUR) } })
    for (let n = 1; n <= it.events; n++) {
      const start = new Date(tomorrowIst(18, 0).getTime() + (n - 1) * DAY + k * HOUR)
      const event = await upsertEvent({ ...base, slug: `${SLUG}interest-${it.slug}-${n}`, title: `Audit FX ${it.label} ${n}`, start, end: endOf(start), place: KORAMANGALA, venueId: null })
      await db.event_categories.deleteMany({ where: { event_id: event.id } })
      await db.event_categories.create({ data: { event_id: event.id, category_id: idOf(it.slug)!, primary: true } })
      made.push(event.id)
    }
  }
  return made
}

/** 818: one video with its own poster, and no cover image on the event. */
async function videoOnlyEvent(base: Base) {
  const start = tomorrowIst(19, 0)
  const event = await upsertEvent({ ...base, slug: `${SLUG}video-only`, title: "Audit FX Video Only", start, end: endOf(start), place: KORAMANGALA, venueId: null, coverless: true })
  const clip = (PHOTOS as unknown as { _clip: { url: string; alt: string } })._clip
  const url = await mirrorToTigris(clip.url, `seed/${SLUG}video-only/clip.mp4`, "video/mp4")
  await db.event_media.deleteMany({ where: { event_id: event.id } })
  await db.event_media.create({ data: { event_id: event.id, type: "video", url, thumbnail_url: cover(`${SLUG}video-poster`), title: clip.alt, order: 0 } })
  return event
}

/**
 * A remote database makes the writers' own 5 s transactions borderline (`createCrew` is about 15 round trips, ~4.5 s from a laptop to
 * Railway). An expired one (P2028) rolled back whole, so asking again is safe.
 */
async function retried<T>(run: () => Promise<T>, attempts = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (attempt >= attempts || (error as { code?: string }).code !== "P2028") throw error
    }
  }
}

/** 835: every host befriends the driver and makes three crews that invite them, through `createCrew`; a re-run renews through `inviteToCrew`. */
async function crewInvites(driverId: string, hostIds: string[]) {
  for (const [h, hostId] of hostIds.entries()) {
    await retried(() => requestFriend(hostId, driverId))
    if ((await retried(() => requestFriend(driverId, hostId))) !== "friends") throw new Error(`${EMAIL(HOSTS[h].n)} and the driver did not become friends`)
    for (let k = 0; k < CREWS_PER_HOST; k++) {
      const name = CREW_NAME(h, k)
      const crew = await db.crews.findFirst({ where: { created_by: hostId, name, dissolved_at: null }, select: { id: true } })
      const made = await retried(() =>
        crew
          ? inviteToCrew(hostId, crew.id, [driverId])
          : createCrew(hostId, createCrewSchema.parse({ name, inviteUserIds: [driverId], revealConsent: true }))
      )
      if (isRefusal(made)) throw new Error(`${name}: ${made.refusal}`)
    }
  }
  return db.crew_invites.count({ where: { invited_user_id: driverId, ...openInviteWhere(), crew: { name: { startsWith: "Audit FX Crew " } } } })
}

async function main() {
  console.log(`\ndatabase: ${hostOf(process.env.DATABASE_URL) || "(unparseable DATABASE_URL)"}`)
  console.log(`mode:     ${CLEAN ? "CLEAN" : APPLY ? "APPLY — this will write" : "dry run"}\n`)
  const refusal = environmentRefusal(process.env)
  if (refusal) {
    console.error(`REFUSING: ${refusal}`)
    process.exitCode = 1
    return
  }
  if (CLEAN) return clean()
  plan()
  if (!APPLY) return console.log("\nDry run. Re-run with --apply to write.\n")
  if (!SEED_PASSWORD) throw new Error("SEED_PASSWORD is required to write: the throwaways sign in with it (the moderated line goes through the real route)")

  const organiser = await db.user.findUnique({ where: { email: ORGANISER_EMAIL }, select: { id: true } })
  const admin = await db.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { id: true } })
  if (!organiser || !admin) throw new Error(`${ORGANISER_EMAIL} / ${ADMIN_EMAIL} missing: run scripts/test-accounts.ts (or seed:qa) first`)
  const org = await db.organisation_members.findFirst({ where: { user_id: organiser.id }, select: { org_id: true } })
  const orgId = org?.org_id ?? null

  const accounts = await ensureAccounts([...PEOPLE.map((name, i) => ({ n: i + 1, name })), DRIVER, ...HOSTS])
  const people = accounts.slice(0, PEOPLE.length)
  const driverId = accounts[PEOPLE.length]
  const venueA = await ensureVenue(OVERLAP.a, admin.id)
  const venueB = await ensureVenue(OVERLAP.b, admin.id)
  const hall = await ensureVenue(HALL, admin.id)
  const base = { state: "Karnataka", organiserId: organiser.id, orgId, city: "Bengaluru" }

  const liveStart = new Date(NOW.getTime() - HOUR)
  const liveEnd = new Date(NOW.getTime() + 5 * HOUR)
  const evA = await upsertEvent({ ...base, slug: `${SLUG}overlap-a`, title: "Audit FX Overlap A", start: liveStart, end: liveEnd, place: OVERLAP.a, venueId: venueA.id })
  const evB = await upsertEvent({ ...base, slug: `${SLUG}overlap-b`, title: "Audit FX Overlap B", start: liveStart, end: liveEnd, place: OVERLAP.b, venueId: venueB.id })
  const ended = await upsertEvent({
    ...base,
    slug: `${SLUG}just-ended`,
    title: "Audit FX Just Ended",
    start: new Date(NOW.getTime() - 3 * HOUR),
    end: new Date(NOW.getTime() - 40 * MIN),
    place: HALL,
    venueId: hall.id,
  })

  // (b) four people were there and left; the room is still open, with its evening in it.
  for (const [i, id] of people.slice(0, 4).entries()) {
    await checkIn(ended.id, id, new Date(NOW.getTime() - (170 - i * 5) * MIN), HALL, new Date(NOW.getTime() - (50 - i) * MIN))
  }
  const endedRoom = await rebuildRoom(ended.id, ended.title, people.slice(0, 4), organiser.id, HISTORY, new Date(NOW.getTime() - 45 * MIN))

  // (e) five checked in to Overlap A, after any earlier room they were in.
  for (const [i, id] of people.entries()) await checkIn(evA.id, id, new Date(NOW.getTime() - (30 - i * 3) * MIN), OVERLAP.a)
  const liveRoom = await rebuildRoom(evA.id, evA.title, people, organiser.id, HISTORY.slice(0, 4), new Date(NOW.getTime() - 5 * MIN))

  // (d) the moderated line, through the real route.
  const verdict = await sendThroughTheRoute(EMAIL(5), liveRoom, BANNED_LINE)
  const hiddenRows = await db.chat_messages.count({ where: { chat_group_id: liveRoom, moderation_status: "hidden" } })
  const flags = await db.moderation_flags.count({ where: { message: { chat_group_id: liveRoom } } })

  // (c) one city past the 50 mark.
  for (let n = 1; n <= MYSURU_EVENTS; n++) {
    const day = 1 + Math.floor(((n - 1) * 30) / MYSURU_EVENTS)
    const start = new Date(NOW.getTime() + day * 24 * HOUR + (n % 4) * HOUR)
    await upsertEvent({
      slug: `${SLUG}mysuru-${String(n).padStart(2, "0")}`,
      title: `Audit FX Mysuru Meetup ${String(n).padStart(2, "0")}`,
      start,
      end: new Date(start.getTime() + 3 * HOUR),
      place: { name: `Audit FX Mysuru Hall ${(n % 5) + 1}`, lat: MYSURU.lat + (n % 7) * 0.001, lng: MYSURU.lng + (n % 5) * 0.001 },
      city: MYSURU.city,
      state: MYSURU.state,
      venueId: null,
      organiserId: organiser.id,
      orgId,
    })
  }

  // (f)-(k): the tickets that need their own shape.
  const [lateNight, lateEvening] = await lateNightEvents(base)
  const nearest = await nearbyCluster(base)
  const interestIds = await interestEvents(base, driverId)
  const videoOnly = await videoOnlyEvent(base)
  const indiranagar = await ensureVenue(INDIRANAGAR, admin.id)
  const unlisted = await upsertEvent({ ...base, slug: `${SLUG}unlisted-area`, title: "Audit FX Unlisted At Area", start: tomorrowIst(19, 30), end: endOf(tomorrowIst(19, 30)), place: INDIRANAGAR, venueId: indiranagar.id, unlisted: true })
  const openInvites = await crewInvites(driverId, accounts.slice(PEOPLE.length + 1))
  if (openInvites <= 50) throw new Error(`the driver has ${openInvites} open crew invites; the fixture needs more than 50`)

  console.log(`\nmoderated line: route answered ${verdict.status}, moderation_hidden=${verdict.hidden}; rows hidden in the room: ${hiddenRows}; flags: ${flags}`)
  if (verdict.status !== 201 && verdict.status !== 200) throw new Error("the send route did not accept the line")
  if (!verdict.hidden || hiddenRows !== 1 || flags < 1) throw new Error("the keyword filter did not hide the line, which is the fixture's whole point")

  const mysuru = await db.events.count({ where: { slug: { startsWith: `${SLUG}mysuru-` }, deleted_at: null, ...realEventsWhere } })
  console.log("\nFixtures (log these on SCRUM-208):")
  console.log(`  (a) Overlap A  event ${evA.id}  venue ${venueA.id}  ${OVERLAP.a.lat}, ${OVERLAP.a.lng}  r60`)
  console.log(`      Overlap B  event ${evB.id}  venue ${venueB.id}  ${OVERLAP.b.lat}, ${OVERLAP.b.lng}  r60`)
  console.log(`      inside both: ${OVERLAP.point.lat}, ${OVERLAP.point.lng}`)
  console.log(`  (b) Just Ended event ${ended.id}  room ${endedRoom}  venue ${hall.id}  ${HALL.lat}, ${HALL.lng}`)
  console.log(`  (c) ${MYSURU.city}: ${mysuru} events (slug ${SLUG}mysuru-NN), centre ${MYSURU.lat}, ${MYSURU.lng}`)
  console.log(`  (d) hidden message in room ${liveRoom} (Overlap A), sent by ${EMAIL(5)}`)
  console.log(`  (e) Overlap A checked in: ${PEOPLE.map((p, i) => `${EMAIL(i + 1)} (${p})`).join(", ")}`)
  console.log(`  (f) 795 late night  event ${lateNight.id} 01:30 IST ${lateNight.start_time.toISOString()}; late evening ${lateEvening.id} 23:30 IST; ${KORAMANGALA.lat}, ${KORAMANGALA.lng}`)
  console.log(`  (g) 797 nearest     event ${nearest.id}  ${HUBBALLI.lat}, ${HUBBALLI.lng} (${HUBBALLI.city}; ${RING_EVENTS} ring events 2-3 km out start before it; it starts ${nearest.start_time.toISOString()})`)
  console.log(`  (h) 798 interests   driver ${EMAIL(DRIVER.n)}: ${INTERESTS.map((i) => `${i.slug} x${i.events}`).join(", ")}; events ${interestIds.join(", ")}`)
  console.log(`  (i) 818 video-only  event ${videoOnly.id}  ${KORAMANGALA.lat}, ${KORAMANGALA.lng}`)
  console.log(`  (j) 823 unlisted    event ${unlisted.id}  venue ${indiranagar.id} area "${INDIRANAGAR.area}"  ${INDIRANAGAR.lat}, ${INDIRANAGAR.lng}`)
  console.log(`  (k) 835 crew invites: ${openInvites} open to ${EMAIL(DRIVER.n)} (driver ${driverId}), from ${CREW_HOSTS} hosts ${EMAIL(HOSTS[0].n)} .. ${EMAIL(HOSTS[HOSTS.length - 1].n)}`)
  console.log("  password: SEED_PASSWORD (Railway staging). Times are now-relative: re-run --apply to bring them back.\n")
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
