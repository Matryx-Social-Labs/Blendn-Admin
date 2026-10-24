// Relative imports: reachable from `server.ts` (via `background.ts`), which
// `build:server` compiles with plain tsc -- the `@/` alias would be emitted verbatim.
import { db } from "./db"
import { logger } from "./logger"
import { checkTextContents } from "./moderation/openai-moderation"
import { breakerIsOpen } from "./moderation/text-breaker"
import type { ModerationResult } from "./moderation/types"
import { checkAndAutoMute, flagForReview, hideMessage } from "./moderation/actions"
import { HELD_ROW_STALE_MS } from "./moderation/held-row"

/**
 * Room messages OpenAI could not look at get looked at again (moderation-degraded policy).
 *
 * `moderation_status = 'unchecked'` means the text check failed for a message
 * that was delivered anyway. Nothing ever revisited those rows, so during an
 * outage they stayed visible for good; the dashboard only counted them. This
 * asks again, in batches, and applies the verdict through the same actions the
 * live pipeline uses (`hideMessage` removes it from the room over the socket,
 * `flagForReview`, `checkAndAutoMute`), so a late hide means what an early one does.
 *
 * It skips the whole pass while the breaker is open (the check would answer
 * "did not look" for every row), and leaves a row it still cannot check for the
 * next pass. Rows older than `RECHECK_WINDOW_MS` are left alone: a day-old line
 * has had its audience.
 *
 * A pass keeps draining while a batch comes back full and settled (at most
 * `RECHECK_MAX_BATCHES_PER_PASS` batches), so a backlog after a long outage
 * clears at up to 64 x 20 messages a minute rather than 64. Oldest first.
 *
 * It never overwrites a decision: a verdict is first claimed with
 * `WHERE moderation_status = 'unchecked'`, and a row a moderator (or the live
 * pipeline) settled meanwhile is skipped.
 *
 * It also deletes abandoned holds (`held-row.ts`): a big room's line held for
 * its check whose request died. They were never emitted.
 *
 * Direct messages are not here: `private_messages` never gets `unchecked`.
 * `lib/dm-moderation.ts` runs no model by decision (TR5), so a DM's status is
 * NULL or `flagged`/`hidden` from the deterministic checks and there is no
 * unchecked state to revisit.
 */
export const RECHECK_INTERVAL_MS = 60_000
export const RECHECK_WINDOW_MS = 24 * 60 * 60 * 1000
export const RECHECK_BATCH_LIMIT = 64
export const RECHECK_MAX_BATCHES_PER_PASS = 20

export interface RecheckResult {
  /** Rows taken this pass. */
  looked: number
  /** Rows given a verdict (hidden, flagged or clean). */
  settled: number
}

export async function recheckUncheckedMessages(now: Date = new Date()): Promise<RecheckResult> {
  // Without a key every look is "did not look"; with the breaker open, ditto.
  if (!process.env.OPENAI_API_KEY || breakerIsOpen()) return { looked: 0, settled: 0 }

  const rows = await db.chat_messages.findMany({
    where: {
      moderation_status: "unchecked",
      deleted_at: null,
      // An empty string is not valid vendor input, and would fail its whole chunk.
      content: { not: "" },
      created_at: { gte: new Date(now.getTime() - RECHECK_WINDOW_MS) },
    },
    orderBy: { created_at: "asc" },
    take: RECHECK_BATCH_LIMIT,
    select: { id: true, content: true, user_id: true, chat_group_id: true },
  })
  if (rows.length === 0) return { looked: 0, settled: 0 }

  const checks = await checkTextContents(rows.map((r) => r.content))
  let settled = 0
  for (const [i, row] of rows.entries()) {
    const check = checks[i]
    if (!check.checked) continue
    try {
      if (await applyVerdict(row, check.result)) settled += 1
    } catch (error) {
      logger.error("Moderation re-check failed for one message", { messageId: row.id, error: String(error) })
    }
  }
  return { looked: rows.length, settled }
}

type Row = { id: string; user_id: string; chat_group_id: string }

/** Whether this pass settled the row; false when somebody else already had. */
async function applyVerdict(row: Row, result: ModerationResult | null): Promise<boolean> {
  const status = !result ? "clean" : result.action === "hide" ? "hidden" : "flagged"
  // Claimed first, on the status we read: a moderator's decision is never overwritten.
  const claimed = await db.chat_messages.updateMany({
    where: { id: row.id, moderation_status: "unchecked" },
    data: { moderation_status: status, ...(status === "hidden" && { deleted_at: new Date() }) },
  })
  if (claimed.count === 0 || !result) return claimed.count > 0
  if (result.action === "hide") {
    await hideMessage(row.id, row.chat_group_id, row.user_id, result)
    await flagForReview(row.id, row.chat_group_id, row.user_id, result)
    await checkAndAutoMute(row.user_id, row.chat_group_id)
  } else {
    await flagForReview(row.id, row.chat_group_id, row.user_id, result)
  }
  return true
}

/** Held rows whose request died (`held-row.ts`), in the same 24 h window as the re-check. */
export async function discardAbandonedHolds(now: Date = new Date()): Promise<number> {
  const { count } = await db.chat_messages.deleteMany({
    where: {
      deleted_at: { lt: new Date(now.getTime() - HELD_ROW_STALE_MS) },
      deleted_by: null,
      moderation_status: null,
      created_at: { gte: new Date(now.getTime() - RECHECK_WINDOW_MS) },
      chat_group: { kind: "event" },
    },
  })
  return count
}

let timer: ReturnType<typeof setTimeout> | null = null
let stopped = false

/** One minute's work: abandoned holds, then batches while they come back full. */
export async function recheckBacklog(): Promise<RecheckResult & { abandoned: number }> {
  const abandoned = await discardAbandonedHolds()
  let looked = 0
  let settled = 0
  for (let batch = 0; batch < RECHECK_MAX_BATCHES_PER_PASS; batch++) {
    const pass = await recheckUncheckedMessages()
    looked += pass.looked
    settled += pass.settled
    // Another batch only when this one was full and every row of it was settled (a stuck row would just be picked again).
    if (pass.looked < RECHECK_BATCH_LIMIT || pass.settled < pass.looked) break
  }
  return { looked, settled, abandoned }
}

async function runRecheck(): Promise<void> {
  try {
    const { looked, settled, abandoned } = await recheckBacklog()
    if (looked > 0 || abandoned > 0) logger.info("Moderation re-check", { looked, settled, abandoned })
  } catch (error) {
    logger.error("Moderation re-check failed", { error: String(error) })
  }
}

/** Self-scheduling, like the other sweepers: a slow pass must not overlap the next. */
export function startModerationRecheckSweeper(): void {
  if (timer) return
  stopped = false
  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => {
      void runRecheck().finally(schedule)
    }, RECHECK_INTERVAL_MS)
    timer.unref?.()
  }
  // Boot is when a deploy's backlog gets cleared.
  void runRecheck().finally(schedule)
}

export function stopModerationRecheckSweeper(): void {
  stopped = true
  if (timer) clearTimeout(timer)
  timer = null
}
