// Relative imports: reachable from server.ts, and `build:server` compiles with
// plain tsc, which emits the @/ alias verbatim into the require().
import { db } from "./db"
import { logger } from "./logger"
import { performCheckout } from "./checkout"
import { validateGeofence, type Geofence } from "./geofence"
import { evaluatePresence, type PresenceState } from "./presence"

/**
 * Close out people who have gone.
 *
 * Mirrors `lib/chat-lifecycle.ts` — same self-scheduling shape, same stop hook
 * in server.ts. A second scheduler would be a second thing to remember to start.
 *
 * The decision is not made here. `lib/presence.ts` decides, this applies. That
 * split is why every rule about noisy GPS is unit-testable without a database.
 */

export const SWEEP_INTERVAL_MS = 5 * 60 * 1000

/**
 * The share of one room the sweeper may close in a single pass.
 *
 * A venue whose wifi dies, or whose basement swallows GPS, produces a burst of
 * out-of-fence readings that look exactly like everyone leaving at once. Acting
 * on that would empty the room on the organiser's screen and read as an
 * evacuation.
 *
 * So past this share, the pass acts on **nobody** and raises an alert instead.
 * The organiser is told the count is unreliable rather than handed a wrong one,
 * which is the whole difference between a useful number and a dangerous one.
 *
 * 25% is a starting point, not a finding. Every trip is logged so the first
 * real event tells us the right number.
 */
export const MASS_CHECKOUT_THRESHOLD = 0.25

export interface SweepResult {
  examined: number
  prompted: number
  checkedOut: number
  /** Events where the guard tripped and nothing was done. */
  guarded: string[]
}

/** The fence to judge against: the event's own, or the venue's if it has none. */
function fenceFor(raw: unknown): Geofence | null {
  if (!raw) return null
  const parsed = validateGeofence(raw)
  return parsed.ok ? parsed.fence : null
}

export async function sweepPresence(now: Date = new Date()): Promise<SweepResult> {
  const result: SweepResult = { examined: 0, prompted: 0, checkedOut: 0, guarded: [] }

  const open = await db.event_check_ins.findMany({
    where: { status: "checked_in" },
    select: {
      id: true,
      event_id: true,
      user_id: true,
      kind: true,
      last_seen_at: true,
      left_area_at: true,
      departure_prompted_at: true,
      occurrence: { select: { end_time: true } },
      event: { select: { geofence: true, venue: { select: { geofence: true } } } },
    },
  })
  result.examined = open.length
  if (open.length === 0) return result

  // Grouped so the guard can reason about a room rather than a person.
  const byEvent = new Map<string, typeof open>()
  for (const row of open) {
    byEvent.set(row.event_id, [...(byEvent.get(row.event_id) ?? []), row])
  }

  for (const [eventId, rows] of byEvent) {
    const fence = fenceFor(rows[0].event.geofence) ?? fenceFor(rows[0].event.venue?.geofence)

    const decisions = rows.map((row) => {
      const state: PresenceState = {
        kind: row.kind,
        leftAreaAt: row.left_area_at,
        departurePromptedAt: row.departure_prompted_at,
        lastSeenAt: row.last_seen_at,
      }
      // The sweeper never has a ping — it runs between them. Its job is the
      // passage of time: grace expiring, a prompt going unanswered, a day
      // ending. `evaluatePresence` treats a null ping as silence, which never
      // causes a mid-event checkout.
      return {
        row,
        decision: fence
          ? evaluatePresence(state, null, fence, row.occurrence.end_time, now)
          : // No fence at all: the only thing that can close them out is the
            // day ending, which is handled below without geometry.
            ({
              action:
                now.getTime() > row.occurrence.end_time.getTime() + 60 * 60_000
                  ? ("auto_checkout" as const)
                  : ("stay" as const),
              reason: "occurrence_ended" as const,
            }),
      }
    })

    const toCheckOut = decisions.filter((d) => d.decision.action === "auto_checkout")

    /*
     * The guard. Deliberately does not apply to `occurrence_ended` — a finished
     * event emptying its room is expected, not a signal, and refusing to close
     * it would leave every attendee checked in for ever.
     */
    const departures = toCheckOut.filter((d) => d.decision.reason !== "occurrence_ended")
    if (departures.length > 0 && departures.length / rows.length > MASS_CHECKOUT_THRESHOLD) {
      result.guarded.push(eventId)
      logger.warn("Presence sweep guarded: too many departures at once", {
        eventId,
        wouldCheckOut: departures.length,
        inRoom: rows.length,
        threshold: MASS_CHECKOUT_THRESHOLD,
        hint: "venue signal loss looks identical to everyone leaving; count is unreliable",
      })
      // Still close out anyone whose day simply ended.
      for (const d of toCheckOut.filter((x) => x.decision.reason === "occurrence_ended")) {
        const done = await performCheckout(d.row.id, "occurrence_ended", now)
        if (done?.changed) result.checkedOut++
      }
      continue
    }

    for (const { row, decision } of decisions) {
      switch (decision.action) {
        case "auto_checkout": {
          const done = await performCheckout(
            row.id,
            decision.reason === "occurrence_ended" ? "occurrence_ended" : "left_area",
            now
          )
          if (done?.changed) result.checkedOut++
          break
        }
        case "prompt": {
          await db.event_check_ins.update({
            where: { id: row.id },
            data: { departure_prompted_at: now },
          })
          result.prompted++
          break
        }
        default:
          break
      }
    }
  }

  if (result.checkedOut > 0 || result.prompted > 0 || result.guarded.length > 0) {
    logger.info("Presence sweep", { ...result, guarded: result.guarded.join(",") })
  }
  return result
}

let timer: NodeJS.Timeout | null = null

/**
 * Self-scheduling rather than `setInterval`, so a slow pass cannot overlap the
 * next one. Same reasoning as the chat lifecycle sweeper.
 */
export function startPresenceSweeper(): void {
  if (timer) return
  const run = async () => {
    try {
      await sweepPresence()
    } catch (error) {
      // A sweep that throws must not take the process down or stop the loop.
      logger.error("Presence sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      timer = setTimeout(run, SWEEP_INTERVAL_MS)
    }
  }
  timer = setTimeout(run, SWEEP_INTERVAL_MS)
}

export function stopPresenceSweeper(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
