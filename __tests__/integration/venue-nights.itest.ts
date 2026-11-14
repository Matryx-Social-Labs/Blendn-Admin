/**
 * @jest-environment node
 */
import { venueNights } from "@/lib/venue-nights"
import { venueTonight } from "@/lib/venue-room-tonight"
import { venueDayBounds, venueDayFor } from "@/lib/venue-day"
import { SYSTEM_USER_ID } from "@/lib/event-kind"
import { cleanup, closeDb, db, makeEvent, occurrenceOf, putInRoom, testId } from "./helpers"
import { DAY, VenueClaimWorld } from "./venue-claim-world"

/*
 * "Nights here" and "Tonight at <venue>" (Venue C, SCRUM-1051, approvals 8
 * and 9), on real rows. The venue's own venue day reads as ranges, met someone
 * included; another host's night at the venue shows who came as a band and
 * says "host's" for how people met. The host's own read of the same night is
 * the control: the "host's" is about who is asking, not about the night.
 */

const w = new VenueClaimWorld()
const venueDays: string[] = []
let venue = { id: "", owner_org_id: null as string | null, claimed_at: null as Date | null, timezone: "Asia/Kolkata", day_reset_hour: 6 }
let hostNight = ""
let today = ""
let frozen = ""
let claim = new Date()

async function guests(eventId: string, n: number, opts: { live: boolean; at: Date }) {
  const occurrenceId = await occurrenceOf(eventId)
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const id = await w.user(`vn-g${i}`)
    ids.push(id)
    if (opts.live) await putInRoom({ eventId, occurrenceId, userId: id, at: opts.at })
    else
      await db.event_check_ins.create({
        data: { event_id: eventId, occurrence_id: occurrenceId, user_id: id, kind: "attendee", status: "checked_out", check_in_time: opts.at, check_out_time: new Date(opts.at.getTime() + 3_600_000) },
      })
  }
  return ids
}

/** Mutual waves between consecutive guests: `pairs` pairs, so 2 × pairs people met someone. */
async function mutualWaves(eventId: string, ids: string[], pairs: number) {
  for (let k = 0; k < pairs; k++) {
    await db.event_waves.create({ data: { event_id: eventId, from_id: ids[2 * k], to_id: ids[2 * k + 1] } })
    await db.event_waves.create({ data: { event_id: eventId, from_id: ids[2 * k + 1], to_id: ids[2 * k] } })
  }
}

async function moods(eventId: string, positive: number, neutral: number, negative: number) {
  const rows = [
    ...Array(positive).fill("positive"),
    ...Array(neutral).fill("neutral"),
    ...Array(negative).fill("negative"),
  ].map((sentiment) => ({ event_id: eventId, sentiment, category: sentiment === "negative" ? "entry_queue" : "other", confidence: 0.9, source: "llm" }) as const)
  await db.event_feedback.createMany({ data: rows })
}

beforeAll(async () => {
  const owner = await w.user("vn-owner", "organizer")
  const host = await w.user("vn-host", "organizer")
  w.venueOrg = await w.org("vn-venue-org", owner)
  w.hostOrg = await w.org("vn-host-org", host)
  w.owner = owner
  w.host = host
  claim = new Date(Date.now() - 10 * DAY)
  const v = await db.venues.create({
    data: { name: testId("vn-venue"), latitude: 12.9, longitude: 77.5, owner_org_id: w.venueOrg, claimed_at: claim, timezone: "Asia/Kolkata", day_reset_hour: 6 },
    select: { id: true },
  })
  w.venues.push(v.id)
  venue = { ...venue, id: v.id, owner_org_id: w.venueOrg, claimed_at: claim }

  // Another host's night yesterday: 9 came, 3 pairs met (6 of 9), 6 positive and 5 negative.
  hostNight = await makeEvent(host)
  w.events.push(hostNight)
  const yesterday = new Date(Date.now() - DAY)
  await db.events.update({ where: { id: hostNight }, data: { venue_id: v.id, organizer_org_id: w.hostOrg, start_time: yesterday, end_time: new Date(yesterday.getTime() + 3 * 3_600_000) } })
  await mutualWaves(hostNight, await guests(hostNight, 9, { live: false, at: yesterday }), 3)
  await moods(hostNight, 6, 0, 5)

  // The venue's own day, live now: 12 in the room, 3 pairs met (6 of 12), 6 positive, 2 negative; 3 offers redeemed at the door.
  const day = await venueDayFor(v.id)
  if (!day) throw new Error("no venue day")
  today = day.id
  venueDays.push(today)
  await mutualWaves(today, await guests(today, 12, { live: true, at: new Date(Date.now() - 20 * 60_000) }), 3)
  await moods(today, 6, 0, 2)
  const offer = await db.venue_offers.create({
    data: { venue_id: v.id, org_id: w.venueOrg, text: "itest offer", audience: "regulars", audience_size: 10, ends_at: new Date(Date.now() + 7 * DAY) },
  })
  const night = new Date(`${venueDayBounds("Asia/Kolkata", 6, new Date()).localDate}T00:00:00Z`)
  for (const userId of w.users.slice(-3)) {
    await db.venue_offer_sends.create({ data: { offer_id: offer.id, venue_id: v.id, user_id: userId, opened_at: new Date(), redeemed_at: new Date(), redeemed_night: night } })
  }

  // A venue day three days ago with only its frozen tally (4 of 20 met): the reader must take the tally.
  const start = new Date(Date.now() - 3 * DAY)
  const old = await db.events.create({
    data: {
      slug: testId("vn-old-day"), title: "Venue day · itest", description: "", start_time: start, end_time: new Date(start.getTime() + DAY),
      timezone: "Asia/Kolkata", status: "published", organizer_id: SYSTEM_USER_ID, visibility: "unlisted", kind: "venue_day", venue_id: v.id,
    },
  })
  frozen = old.id
  venueDays.push(frozen)
  await db.event_insight_tallies.create({
    data: { event_id: frozen, counts: { connections: { attendees: 20, connections: 2, connected: 4, reachedOut: 4 }, lobby: { offer: 0, seeking: 0, chat: 0, asks: 0, accepted: 0 }, tonight: { answered: 0, workIntent: { hire: 0, find_work: 0, build: 0, learn: 0 } } } },
  })
}, 120_000)

afterAll(async () => {
  const all = [...w.events, ...venueDays]
  await db.venue_offer_sends.deleteMany({ where: { venue_id: { in: w.venues } } })
  await db.venue_offers.deleteMany({ where: { venue_id: { in: w.venues } } })
  await db.event_waves.deleteMany({ where: { event_id: { in: all } } })
  await db.event_feedback.deleteMany({ where: { event_id: { in: all } } })
  await db.event_insight_tallies.deleteMany({ where: { event_id: { in: all } } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: venueDays } } })
  // A venue day keeps its venue (events_venue_day_shape): gone before the world unlinks its own nights.
  await cleanup([], venueDays)
  await w.teardown()
  await closeDb()
}, 120_000)

/** The window the page passes: twenty days either side, so only the claim cuts it. */
const wide = () => ({ from: new Date(Date.now() - 20 * DAY), to: new Date(Date.now() + 20 * DAY) })
const ownerActor = () => ({ id: w.owner, orgIds: [w.venueOrg] })

describe("Nights here, as the venue's owner reads it", () => {
  it("gives its own venue day as ranges, met someone included, and offers redeemed as under 5", async () => {
    const rows = await venueNights(venue, wide(), ownerActor())
    expect(rows.find((r) => r.id === today)).toMatchObject({
      venueDay: true,
      host: "Your room",
      came: "10–19",
      met: "about half",
      offers: "under 5",
      mood: { parts: [6, 0, "few"], word: "mostly positive" },
    })
  })

  it("says host's for how people met on another host's night, and still shows who came as a band", async () => {
    const rows = await venueNights(venue, wide(), ownerActor())
    expect(rows.find((r) => r.id === hostNight)).toMatchObject({ venueDay: false, came: "5–9", met: "hosts", offers: null, mood: { parts: [6, 0, 5], word: "mixed" } })
  })

  it("is the asker, not the night: the host reading its own night gets the range (control)", async () => {
    const rows = await venueNights(venue, wide(), { id: w.host, orgIds: [w.hostOrg] })
    expect(rows.find((r) => r.id === hostNight)?.met).toBe("most")
  })

  it("reads a frozen night from its tally, not from rows the purges have taken", async () => {
    const rows = await venueNights(venue, wide(), ownerActor())
    // Counted now it would be held: no check-ins are left. The tally says 4 of 20.
    expect(rows.find((r) => r.id === frozen)).toMatchObject({ came: "Under 5", met: "under a quarter" })
  })

  it("carries no exact count of people anywhere in a row", async () => {
    const rows = await venueNights(venue, wide(), ownerActor())
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["came", "host", "id", "met", "mood", "night", "offers", "rating", "startAt", "status", "venueDay"])
      expect(r.came).toMatch(/^(Under 5|5–9|10–19|20\+)$/)
    }
  })

  it("shows nothing before the claim, and nothing at all without one; an admin reads the whole range", async () => {
    // Claimed a minute before today's venue day began: yesterday's host night and the frozen day are before it.
    const { start_time } = await db.events.findUniqueOrThrow({ where: { id: today }, select: { start_time: true } })
    const lateClaim = { ...venue, claimed_at: new Date(start_time.getTime() - 60_000) }
    expect((await venueNights(lateClaim, wide(), ownerActor())).map((r) => r.id)).toEqual([today])
    expect(await venueNights({ ...venue, claimed_at: null }, wide(), ownerActor())).toEqual([])
    // The control: an admin, no claim cut.
    expect((await venueNights({ ...venue, claimed_at: null }, wide(), null)).length).toBe(3)
  })
})

describe("Tonight at the venue", () => {
  it("shows the venue's own day live, every count a range", async () => {
    const t = await venueTonight(venue, ownerActor())
    expect(t).toMatchObject({ eventId: today, venueDay: true, label: "venue day", inRoom: "10–19", met: "about half", mood: "mostly positive", offers: "under 5" })
  })

  it("on another host's night shows the room and the mood, and says host's for met someone and crews", async () => {
    const second = await db.venues.create({
      data: { name: testId("vn-venue2"), latitude: 12.9, longitude: 77.5, owner_org_id: w.venueOrg, claimed_at: claim, timezone: "Asia/Kolkata", day_reset_hour: 6 },
      select: { id: true },
    })
    w.venues.push(second.id)
    const live = await makeEvent(w.host)
    w.events.push(live)
    await db.events.update({ where: { id: live }, data: { venue_id: second.id, organizer_org_id: w.hostOrg } })
    await mutualWaves(live, await guests(live, 9, { live: true, at: new Date(Date.now() - 10 * 60_000) }), 3)
    const at = { ...venue, id: second.id }
    expect(await venueTonight(at, ownerActor())).toMatchObject({ eventId: live, venueDay: false, inRoom: "5–9", met: "hosts", crews: "hosts" })
    // The control: its host reads the same room with met someone.
    expect((await venueTonight(at, { id: w.host, orgIds: [w.hostOrg] }))?.met).toBe("most")
  })

  it("is nothing when no claim, and nothing when the room is not running", async () => {
    expect(await venueTonight({ ...venue, claimed_at: null }, ownerActor())).toBeNull()
    expect(await venueTonight(venue, ownerActor(), new Date(Date.now() + 3 * DAY))).toBeNull()
  })
})
