import { db } from "@/lib/db"
import { liveCountBucket, liveCountLabel } from "@/lib/disclosure"
import { hostsEvent } from "@/lib/event-visibility"
import { buildLiveSnapshot, type Held } from "@/lib/live-snapshot"
import { venueDayBounds } from "@/lib/venue-day"
import { crewsCell, metRange, offersBand, venueMood, type MetRange, type MoodWord } from "@/lib/venue-nights"

/**
 * "Tonight at <venue>" (Venue C, SCRUM-1051): the room running at the venue
 * now, as its owner is told it. Every count of people a range; mood a word;
 * met someone and crews on the venue's own venue day only (approval 9), and
 * "host's" on a night another host runs. Words only leave the server.
 */
export interface VenueTonight {
  eventId: string
  venueDay: boolean
  /** "venue day", or the host's name. */
  label: string
  inRoom: string
  arriving: string
  mood: MoodWord | "quiet"
  /** Null: the social read failed this minute. */
  met: MetRange | "held" | "hosts" | null
  /** Null between a venue day's days (no day resolves); `"hosts"` on another host's night. */
  crews: string | "hosts" | null
  /** The venue's own door, tonight; null for a venue with no owner (no offers). */
  offers: string | null
}

/*
 * One snapshot read per room per minute, however many owners' tabs refresh it:
 * `buildLiveSnapshot` holds the event and the heavy social read in `Held`
 * (HELD_SOCIAL_MS), and shares a read in flight.
 * ponytail: per process and per bundle layer; cleared whole past ROOMS_HELD.
 */
const held = new Map<string, Held>()
const ROOMS_HELD = 200

function heldFor(eventId: string): Held {
  if (!held.has(eventId) && held.size >= ROOMS_HELD) held.clear()
  const h = held.get(eventId) ?? {}
  held.set(eventId, h)
  return h
}

/**
 * The room to show, or null when nothing runs: the venue day first (it is the
 * venue's own), then a night the owner's organisation hosts, then another
 * host's. `since` is the claim window (null: no claim, no rooms); `actor` null
 * is an admin, who reads every room as the venue's own.
 */
export async function venueTonight(
  venue: { id: string; owner_org_id: string | null; timezone: string; day_reset_hour: number },
  since: { gte: Date } | null | undefined,
  actor: { id: string; orgIds: readonly string[] } | null,
  now: Date = new Date()
): Promise<VenueTonight | null> {
  if (since === null) return null
  const live = await db.events.findMany({
    /*
     * any-kind: the venue's own live room and the hosts' nights both run here;
     * the panel shows whichever is the venue's, else what it may see of a
     * host's (as the building panel reads them, lib/building-occupancy.ts).
     */
    where: {
      venue_id: venue.id,
      deleted_at: null,
      status: "published",
      start_time: { lte: now, ...(since ? { gte: since.gte } : {}) },
      end_time: { gte: now },
    },
    orderBy: { start_time: "asc" },
    select: {
      id: true,
      kind: true,
      organizer_id: true,
      organizer_org_id: true,
      organizer_org: { select: { display_name: true } },
      organizer: { select: { name: true } },
    },
  })
  const ownOf = (e: (typeof live)[number]) => e.kind === "venue_day" || !actor || hostsEvent(actor, e)
  const room = live.find((e) => e.kind === "venue_day") ?? live.find(ownOf) ?? live[0]
  if (!room) return null
  const own = ownOf(room)

  const [snapshot, redeemed] = await Promise.all([
    buildLiveSnapshot(room.id, heldFor(room.id), { social: own }),
    venue.owner_org_id
      ? db.venue_offer_sends.count({
          where: {
            venue_id: venue.id,
            redeemed_night: new Date(`${venueDayBounds(venue.timezone, venue.day_reset_hour, now).localDate}T00:00:00Z`),
            offer: { org_id: venue.owner_org_id },
          },
        })
      : null,
  ])
  if (!snapshot) return null
  const social = own ? snapshot.social : null
  return {
    eventId: room.id,
    venueDay: room.kind === "venue_day",
    label: room.kind === "venue_day" ? "venue day" : (room.organizer_org?.display_name ?? room.organizer?.name ?? "another host"),
    inRoom: liveCountLabel(liveCountBucket(snapshot.guestsInside)),
    arriving: liveCountLabel(liveCountBucket(snapshot.checkInRate10m)),
    mood: venueMood(snapshot.sentiment)?.word ?? "quiet",
    met: !own ? "hosts" : !social ? null : social.met.held ? "held" : metRange(social.met.connected, social.attendees),
    crews: !own ? "hosts" : social?.crews ? crewsCell(social.crews.here) : null,
    offers: redeemed === null ? null : offersBand(redeemed),
  }
}
