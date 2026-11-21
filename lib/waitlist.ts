import { doorsAt } from "@/lib/chat-window"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { sendPushNotification } from "@/lib/push-notifications"

/**
 * The RSVP waitlist.
 *
 * RSVP enforced no capacity whatsoever: anyone could say "going" to a
 * 100-capacity room, without limit. That made `going` useless as a planning
 * number — an organiser could not tell 60 interested people from 600 — and made
 * turn-up a ratio against something arbitrary.
 *
 * ## This is not a door policy
 *
 * The waitlist manages **expectations before the event**, never **admission at
 * it**. Check-in still refuses nobody: the geofence covers the queue outside,
 * and someone who turns up and is standing at the venue gets in and gets counted
 * whether they were `going` or `waitlisted`. See `docs/CHECKIN.md` — check-in is
 * a presence proof, not a ticket, and a waitlist that quietly became a bouncer
 * would undo that.
 *
 * So a waitlisted person is told "we're full, we'll let you know" and is not
 * stopped at the door if they come anyway.
 *
 * ## No capacity means no waitlist
 *
 * An event with no `max_capacity` is unbounded exactly as before. Inventing a
 * limit for an event whose organiser never stated one would refuse people on the
 * strength of a number nobody chose.
 */

/** Where an RSVP lands, given how full the event already is. */
export function rsvpPlacement(
  goingCount: number,
  capacity: number | null
): "going" | "waitlisted" {
  if (capacity === null || capacity <= 0) return "going"
  return goingCount >= capacity ? "waitlisted" : "going"
}

/** How many seats a promotion may fill. Never negative. */
export function seatsFree(goingCount: number, capacity: number | null): number {
  if (capacity === null || capacity <= 0) return 0
  return Math.max(capacity - goingCount, 0)
}

/**
 * Take an RSVP, placing it on the waitlist if the event is already full.
 *
 * Someone already `going` who re-submits stays `going` — re-confirming must not
 * cost you the seat you hold, which is what a naive "count, then place" would do
 * by counting your own row against you.
 */
export async function placeRsvp(
  eventId: string,
  userId: string,
  requested: "going" | "maybe" | "not_going"
): Promise<{ status: "going" | "maybe" | "not_going" | "waitlisted"; goingCount: number }> {
  const [event, existing, goingCount] = await Promise.all([
    db.events.findUnique({ where: { id: eventId }, select: { max_capacity: true, start_time: true, status: true } }),
    db.event_rsvps.findUnique({
      where: { event_id_user_id: { event_id: eventId, user_id: userId } },
      select: { status: true, cancelled_at: true },
    }),
    db.event_rsvps.count({ where: { event_id: eventId, status: "going" } }),
  ])

  const status: "going" | "maybe" | "not_going" | "waitlisted" =
    requested !== "going" ? requested : existing?.status === "going" ? "going" : rsvpPlacement(goingCount, event?.max_capacity ?? null)

  // A "not going" from somebody who was committed, once the doors are open, is a late cancel (`cancelled_at`); an
  // earlier one keeps its time, and saying anything else clears it.
  const now = new Date()
  const late = status === "not_going" && !!event && isCommitted(existing?.status) && lateCancelCounts(event, now)
  const cancelled_at = status !== "not_going" ? null : late ? now : (existing?.cancelled_at ?? null)

  await db.event_rsvps.upsert({
    where: { event_id_user_id: { event_id: eventId, user_id: userId } },
    create: { event_id: eventId, user_id: userId, status },
    update: { status, updated_at: now, cancelled_at },
  })

  // Dropping out of `going` frees a seat for whoever is waiting.
  if (requested !== "going") await promoteFromWaitlist(eventId)

  return {
    status,
    goingCount: await db.event_rsvps.count({ where: { event_id: eventId, status: "going" } }),
  }
}

const COMMITTED = ["going", "maybe", "waitlisted"] as const
const isCommitted = (status: string | undefined) => (COMMITTED as readonly string[]).includes(status ?? "")

/** A withdrawal is a late cancel once the doors are open, on a night that is still on (a called-off one has no turn-out). */
const lateCancelCounts = (event: { start_time: Date; status: string }, now: Date) => event.status !== "cancelled" && now >= doorsAt(event)

/**
 * Withdraw an RSVP (`DELETE /events/:id/rsvp`), then give the seat to the waitlist.
 *
 * Before the doors the row is deleted, as it always was. Once they are open (`doorsAt`, check-in) a commitment is
 * kept as `not_going` with `cancelled_at`, so the turn-out forecast and the show rate can tell "can't make it" from a
 * no-show (SCRUM-1095, ROADMAP Going 2). Hosts read counts only. A plain `not_going` is deleted either way; a late
 * cancel already recorded is kept, so a repeated DELETE never erases it.
 */
export async function withdrawRsvp(eventId: string, userId: string): Promise<void> {
  const event = await db.events.findUnique({ where: { id: eventId }, select: { start_time: true, status: true } })
  const now = new Date()
  const mine = { event_id: eventId, user_id: userId }
  if (event && lateCancelCounts(event, now)) {
    await db.event_rsvps.updateMany({
      where: { ...mine, status: { in: [...COMMITTED] } },
      data: { status: "not_going", cancelled_at: now, updated_at: now },
    })
    // A plain "not going" is withdrawn as before; a late cancel already recorded stays (a repeated DELETE).
    await db.event_rsvps.deleteMany({ where: { ...mine, status: "not_going", cancelled_at: null } })
  } else {
    await db.event_rsvps.deleteMany({ where: mine })
  }
  await promoteFromWaitlist(eventId)
}

/**
 * Move people off the waitlist into the seats that have opened, oldest first.
 *
 * Called whenever a seat is released — a cancellation, a change to `maybe`, or
 * an organiser raising the capacity.
 *
 * Each promotion is its own conditional `updateMany` filtered on
 * `status: "waitlisted"`, so two concurrent cancellations cannot promote the
 * same person twice: the second update matches nothing and moves on. The
 * alternative — read the list, then write it — is the shape that
 * double-promotes under exactly the load an event release produces.
 */
export async function promoteFromWaitlist(eventId: string): Promise<string[]> {
  const event = await db.events.findUnique({
    where: { id: eventId },
    select: { max_capacity: true, title: true, status: true, start_time: true, end_time: true },
  })
  if (!event?.max_capacity) return []
  // A night that was called off has no seat to give: promoting would push "a place opened up" for it (SCRUM-892).
  if (event.status === "cancelled") return []
  // Over: nobody is promoted into a night that has ended (SCRUM-1074 (1)).
  const now = new Date()
  if (event.end_time <= now) return []
  // Started: the door already takes waitlisted people, so the seat is theirs without a push.
  const started = event.start_time <= now

  const goingCount = await db.event_rsvps.count({
    where: { event_id: eventId, status: "going" },
  })
  const free = seatsFree(goingCount, event.max_capacity)
  if (free === 0) return []

  const waiting = await db.event_rsvps.findMany({
    where: { event_id: eventId, status: "waitlisted" },
    // The order people joined the queue. Anything else is unfair in a way
    // someone will notice and nobody can explain.
    orderBy: { created_at: "asc" },
    select: { id: true, user_id: true },
    take: free,
  })

  const promoted: string[] = []
  for (const row of waiting) {
    const { count } = await db.event_rsvps.updateMany({
      where: { id: row.id, status: "waitlisted" },
      data: { status: "going", updated_at: new Date() },
    })
    if (count > 0) promoted.push(row.user_id)
  }

  for (const userId of started ? [] : promoted) {
    // Fire and forget: a push that fails must not roll back a seat someone now
    // holds. They will see it in the app either way.
    void sendPushNotification({
      userId,
      title: "You’re in",
      body: `A place opened up at ${event.title}.`,
      data: { type: "waitlist_promoted", eventId },
    }).catch((error) =>
      logger.error("Waitlist promotion push failed", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      })
    )
  }

  return promoted
}
