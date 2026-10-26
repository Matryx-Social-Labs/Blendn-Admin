// Relative, not "@/lib/db". `build:server` compiles this with plain tsc, which
// resolves the @/ alias for typechecking and then emits it verbatim into the
// require() — the build goes green and the container dies on boot with
// MODULE_NOT_FOUND. This module is reachable from server.ts through the
// presence sweeper, so everything it imports must be relative too.
import { Prisma } from "@prisma/client"
import { db } from "./db"
import { closeSession } from "./presence-sessions"
import { logger } from "./logger"
import { arrivalAnnounced } from "./arrivals-in-flight"
import { emitEventCheckOut, emitEventCheckOuts, evictFromVenueDay } from "./socket-server"
import { notifyFriendsHere, notifyFriendsHereMany } from "./room-friends"

/**
 * The one way someone stops being in the room.
 *
 * There were three: the manual checkout route, the branch in check-in that
 * closes your previous event, and (soon) the presence sweeper. Three
 * implementations of the same idea is how they drift — one forgets the chat
 * cutoff, another forgets the socket event, and nobody notices until an
 * organiser asks why a name is still in the list.
 *
 * Idempotent. A row that is already `checked_out` is left alone and reported as
 * such, which is what lets the sweeper run every fifteen minutes without
 * needing to know what the last pass did.
 */

export type CheckoutReason =
  | "manual"
  /** They checked in somewhere else; you cannot be in two rooms. */
  | "switched_event"
  /** Left the geofence and did not answer the prompt. */
  | "left_area"
  /** Still checked in when the day ended. */
  | "occurrence_ended"
  /**
   * A Go Live window ran out, the venue's day reset under it (D-4), or both.
   * Stamped at `expires_at`, not when the sweeper got there (PL-U04).
   */
  | "expired"
  /** A real event started at the venue, and the venue's room is the event's now. */
  | "event_started"

const DEPARTURE_SOURCE: Record<CheckoutReason, "user" | "switch" | "sweeper" | "expired" | "ended"> = {
  manual: "user",
  switched_event: "switch",
  left_area: "sweeper",
  occurrence_ended: "sweeper",
  // Observed, not inferred: the window had a known end (F6).
  expired: "expired",
  // Known too: the event's start, which closed the venue's room.
  event_started: "ended",
}

export interface CheckoutResult {
  changed: boolean
  eventId: string
  userId: string
}

/**
 * Whether this kind of checkout also closes chat access.
 *
 * At an event, an automatic checkout does not. Someone whose GPS wandered while
 * they were mid-conversation should not be thrown out of the room as well — the
 * feedback window already governs when chat closes, and the cost of being wrong
 * here is much higher than a slightly stale attendee count. (The cut it writes,
 * `last_allowed_at`, is not read for an event's room any more: see
 * `mayWriteToRoom`.)
 *
 * At a venue day, every checkout does, and the cut is read: the room is for the
 * people live in it (`liveInVenueDay`), and leaving it however you leave ends
 * your window (F6).
 */
function cutsChatAccess(reason: CheckoutReason, venueDay: boolean): boolean {
  return venueDay || reason === "manual" || reason === "switched_event"
}

export async function performCheckout(
  checkInId: string,
  reason: CheckoutReason,
  now: Date = new Date()
): Promise<CheckoutResult | null> {
  const checkIn = await db.event_check_ins.findUnique({
    where: { id: checkInId },
    select: {
      id: true,
      event_id: true,
      user_id: true,
      status: true,
      occurrence_id: true,
      kind: true,
      event: { select: { kind: true } },
    },
  })
  if (!checkIn) return null
  const venueDay = checkIn.event.kind === "venue_day"

  // Idempotent by design: the sweeper re-reads the same rows every pass.
  if (checkIn.status !== "checked_in") {
    return { changed: false, eventId: checkIn.event_id, userId: checkIn.user_id }
  }

  // Guarded in the statement rather than after the read above, so two callers
  // racing (a sweeper pass and a live manual checkout) cannot both act.
  const { count } = await db.event_check_ins.updateMany({
    where: {
      id: checkInId,
      status: "checked_in",
      // An expiry acts only on the window it read: going live again in between
      // moved `expires_at` past it, and that window is not over. Below the
      // next millisecond, not at it: Postgres keeps microseconds and a JS Date
      // does not, so a row ending at .000500 read back as .000 would never
      // match `lte` and would sit first in the sweep's queue for ever.
      ...(reason === "expired" && { expires_at: { lt: new Date(now.getTime() + 1) } }),
    },
    data: { status: "checked_out", check_out_time: now, updated_at: now },
  })
  if (count === 0) {
    return { changed: false, eventId: checkIn.event_id, userId: checkIn.user_id }
  }

  /*
   * Close the presence session too, in the one place both callers pass through.
   *
   * Written here rather than in the route because the sweeper checks people out
   * as well, and the comment above already says these two must not drift. A
   * session left open by a checkout is somebody who counts as present forever,
   * which is the bug the sessions model exists to make unrepresentable.
   *
   * Recording how lets the occupancy figure say how confident it is instead of
   * presenting inference as observation. Observed: `manual` (they checked out)
   * and a switch (they checked in somewhere else, at a known instant). Inferred:
   * leaving the fence and staying out, and the event's end. The sweeper closes
   * someone who never checked out an hour after the end, and when they really
   * left is a guess, so `occurrence_ended` is `sweeper`, not `ended`, and
   * `departureQuality` counts it as inference (SCRUM-484).
   */
  await closeSession(checkIn.occurrence_id, checkIn.user_id, DEPARTURE_SOURCE[reason], now)

  if (cutsChatAccess(reason, venueDay)) {
    const chatGroup = await db.chat_groups.findUnique({
      where: { event_id: checkIn.event_id },
      select: { id: true },
    })
    if (chatGroup) {
      await db.chat_group_members.updateMany({
        where: { chat_group_id: chatGroup.id, user_id: checkIn.user_id },
        data: { last_allowed_at: now, updated_at: now },
      })
    }
    if (venueDay) evictFromVenueDay(checkIn.event_id, chatGroup?.id ?? null, checkIn.user_id, reason)
  }

  // Emitted here rather than by each caller, so the sweeper cannot forget it
  // and leave the live screen showing someone who has gone. After their
  // arrival's broadcast, never before it, or the roster keeps a ghost.
  await arrivalAnnounced(checkIn.event_id, checkIn.user_id)
  emitEventCheckOut(checkIn.event_id, checkIn.user_id)
  // Their friends here move too (an opted-in friend leaves the list). Every
  // checkout writer comes through here, the sweepers included.
  if (checkIn.kind === "attendee") void notifyFriendsHere(checkIn.user_id, { eventIds: [checkIn.event_id] })

  logger.info("Checked out", {
    checkInId,
    eventId: checkIn.event_id,
    reason,
    chatClosed: cutsChatAccess(reason, venueDay),
  })

  return { changed: true, eventId: checkIn.event_id, userId: checkIn.user_id }
}

/** One check-in to close, and the instant it ended (an expiry's own end, else the sweep's clock). */
export interface CheckoutItem {
  id: string
  at: Date
}

/** Ids per statement: bound parameters, and how long one UPDATE holds its row locks. */
const CHECKOUT_CHUNK = 2000

interface CheckedOutRow {
  id: string
  event_id: string
  user_id: string
  occurrence_id: string
  kind: "attendee" | "staff"
  event_kind: string
  at: Date
}

/**
 * `performCheckout` for a sweep: the same rows, session closures, chat cuts and
 * telling, in a handful of statements for the whole batch instead of ~15 per
 * person. For the sweepers, which close hundreds or thousands at once (an
 * occurrence ending with the room still inside); one person is `performCheckout`.
 *
 * Idempotent the same way: a row already out, or racing a manual checkout, is
 * left alone and simply not returned. Returns only the rows this call changed.
 *
 * Differences from the one-at-a-time path, all deliberate: the departure is
 * `GREATEST(at, arrived_at)` (the one-at-a-time write would have thrown on
 * `presence_sessions_departure_after_arrival` and stopped the sweep); each room
 * is told with one `hereCount` (the room once all of them are out); and the
 * friends-here signal is one batched read per chunk, told once per event.
 */
export async function performCheckouts(items: readonly CheckoutItem[], reason: CheckoutReason): Promise<CheckoutResult[]> {
  const changed: CheckoutResult[] = []
  for (let i = 0; i < items.length; i += CHECKOUT_CHUNK) {
    changed.push(...(await checkOutChunk(items.slice(i, i + CHECKOUT_CHUNK), reason)))
  }
  return changed
}

async function checkOutChunk(items: readonly CheckoutItem[], reason: CheckoutReason): Promise<CheckoutResult[]> {
  const ids = items.map((i) => i.id)
  const ats = items.map((i) => i.at.toISOString())
  // See `performCheckout`: an expiry acts only on the window it read, to the millisecond.
  const sameWindow = reason === "expired" ? Prisma.sql`AND c.expires_at < v.at + interval '1 millisecond'` : Prisma.empty
  // Guarded in the statement, like the one-at-a-time write: a racing caller cannot make both act.
  const rows = await db.$queryRaw<CheckedOutRow[]>`
    WITH moved AS (
      UPDATE event_check_ins c
         SET status = 'checked_out', check_out_time = v.at, updated_at = v.at
        FROM unnest(${ids}::uuid[], ${ats}::timestamptz[]) AS v(id, at)
       WHERE c.id = v.id AND c.status = 'checked_in' ${sameWindow}
   RETURNING c.id, c.event_id, c.user_id, c.occurrence_id, c.kind::text AS kind, v.at
    )
    -- any-kind: the rows are already chosen by id; this only reads each one's kind (a venue day cuts chat access)
    SELECT m.*, e.kind::text AS event_kind FROM moved m JOIN events e ON e.id = m.event_id`
  if (rows.length === 0) return []

  // The sessions, in the one place the checkouts pass through (see `performCheckout`).
  await db.$executeRaw`
    UPDATE presence_sessions ps
       SET departed_at = GREATEST(v.at, ps.arrived_at), departed_source = ${DEPARTURE_SOURCE[reason]}::departure_source, updated_at = v.at
      FROM unnest(${rows.map((r) => r.occurrence_id)}::uuid[], ${rows.map((r) => r.user_id)}::text[], ${rows.map((r) => r.at.toISOString())}::timestamptz[]) AS v(occ, usr, at)
     WHERE ps.occurrence_id = v.occ AND ps.user_id = v.usr AND ps.departed_at IS NULL`

  const cut = rows.filter((r) => cutsChatAccess(reason, r.event_kind === "venue_day"))
  if (cut.length > 0) {
    const groups = await db.chat_groups.findMany({
      where: { event_id: { in: [...new Set(cut.map((r) => r.event_id))] } },
      select: { id: true, event_id: true },
    })
    const groupOf = new Map(groups.map((g) => [g.event_id, g.id]))
    const members = cut.filter((r) => groupOf.has(r.event_id))
    if (members.length > 0) {
      await db.$executeRaw`
        UPDATE chat_group_members m
           SET last_allowed_at = v.at, updated_at = v.at
          FROM unnest(${members.map((r) => groupOf.get(r.event_id))}::uuid[], ${members.map((r) => r.user_id)}::text[], ${members.map((r) => r.at.toISOString())}::timestamptz[]) AS v(grp, usr, at)
         WHERE m.chat_group_id = v.grp AND m.user_id = v.usr`
    }
    for (const r of cut) if (r.event_kind === "venue_day") evictFromVenueDay(r.event_id, groupOf.get(r.event_id) ?? null, r.user_id, reason)
  }

  // After their arrival's broadcast, never before it (see `performCheckout`).
  await Promise.all(rows.map((r) => arrivalAnnounced(r.event_id, r.user_id)))
  const byEvent = new Map<string, string[]>()
  for (const r of rows) byEvent.set(r.event_id, [...(byEvent.get(r.event_id) ?? []), r.user_id])
  for (const [eventId, userIds] of byEvent) emitEventCheckOuts(eventId, userIds)
  void notifyFriendsHereMany(rows.filter((r) => r.kind === "attendee").map((r) => ({ userId: r.user_id, eventId: r.event_id })))

  logger.info("Checked out", { reason, count: rows.length, events: byEvent.size })
  return rows.map((r) => ({ changed: true, eventId: r.event_id, userId: r.user_id }))
}

/** A room a switch took somebody out of, named for the "You left {A}." toast (SCRUM-635). */
export interface LeftRoom {
  eventId: string
  /** `venue_day` is a venue's live room; `name` is then the venue's. */
  kind: "event" | "venue_day"
  name: string
}

export interface SwitchResult extends CheckoutResult {
  reason: CheckoutReason
  /** Set only when the reason is `switched_event`: an expiry or an earlier day was not left by this check-in. */
  left: LeftRoom | null
}

/**
 * Close every open check-in this person has except the one being opened.
 *
 * You cannot be in two rooms (SCRUM-705): the database holds one open row per
 * person (`event_check_ins_one_open_per_user`), and check-in calls this before
 * it writes the new one. Each row closes for what actually ended it:
 *
 * - **another room** — `switched_event`, the switch, and the only one returned
 *   with `left` so the app can say "You left {A}." rather than switching
 *   silently (SCRUM-635);
 * - **a Go Live already over** — `expired` at its own end: the sweeper had
 *   not got to it yet (D-4);
 * - **an earlier day of the same event** — `occurrence_ended`. That day is
 *   over (the door resolved today's), and it is the same room, so the chat is
 *   not cut. This was skipped (`event_id: { not }`), which left day 1 open
 *   beside day 2 until the sweeper came.
 */
export async function checkOutOfOtherEvents(
  userId: string,
  keep: { eventId: string; occurrenceId: string },
  now: Date = new Date()
): Promise<SwitchResult[]> {
  const others = await db.event_check_ins.findMany({
    where: { user_id: userId, status: "checked_in", occurrence_id: { not: keep.occurrenceId } },
    select: {
      id: true,
      event_id: true,
      check_in_time: true,
      expires_at: true,
      occurrence: { select: { end_time: true } },
      event: { select: { kind: true, title: true, venue_name: true, venue: { select: { name: true } } } },
    },
  })

  const results: SwitchResult[] = []
  for (const row of others) {
    const reason: CheckoutReason =
      row.expires_at && row.expires_at <= now ? "expired" : row.event_id === keep.eventId ? "occurrence_ended" : "switched_event"
    /*
     * When it ended: a Go Live at its window's end; an earlier day at that
     * day's end, not at today's door (review L5) — it ended then, and a stay
     * running into the next day is one nobody had; a switch now.
     *
     * Never before they arrived. A door that lost the race to another door
     * (`openCheckIn`) switches out of a row opened a moment AFTER its own
     * `now`, and a departure stamped before the arrival is refused by
     * `presence_sessions_departure_after_arrival` — a 500 at the door, found
     * by the race test.
     */
    const ended =
      reason === "expired" && row.expires_at
        ? row.expires_at
        : reason === "occurrence_ended" && row.occurrence.end_time < now
          ? row.occurrence.end_time
          : now
    const at = row.check_in_time && row.check_in_time > ended ? row.check_in_time : ended
    const result = await performCheckout(row.id, reason, at)
    if (!result) continue
    const { kind } = row.event
    const left =
      reason === "switched_event" && result.changed
        ? { eventId: row.event_id, kind, name: kind === "venue_day" ? row.event.venue?.name ?? row.event.venue_name ?? "the venue" : row.event.title }
        : null
    results.push({ ...result, reason, left })
  }
  return results
}
