// Relative imports: reachable from `server.ts` (via `background.ts`), which
// `build:server` compiles with plain tsc -- the `@/` alias would be emitted verbatim.
import { db } from "./db"
import { logger } from "./logger"
import { checkTextContents } from "./moderation/openai-moderation"
import { breakerIsOpen } from "./moderation/text-breaker"
import type { ModerationResult } from "./moderation/types"
import { checkAndAutoMute, flagForReview, hideMessage, recordExamined } from "./moderation/actions"

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
 * Direct messages are not here: `private_messages` never gets `unchecked`.
 * `lib/dm-moderation.ts` runs no model by decision (TR5), so a DM's status is
 * NULL or `flagged`/`hidden` from the deterministic checks and there is no
 * unchecked state to revisit.
 */
export const RECHECK_INTERVAL_MS = 60_000
export const RECHECK_WINDOW_MS = 24 * 60 * 60 * 1000
export const RECHECK_BATCH_LIMIT = 64

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
    settled += 1
    try {
      await applyVerdict(row, check.result)
    } catch (error) {
      logger.error("Moderation re-check failed for one message", { messageId: row.id, error: String(error) })
    }
  }
  return { looked: rows.length, settled }
}

type Row = { id: string; user_id: string; chat_group_id: string }

async function applyVerdict(row: Row, result: ModerationResult | null) {
  if (!result) return recordExamined(row.id, true)
  if (result.action === "hide") {
    await hideMessage(row.id, row.chat_group_id, row.user_id, result)
    await flagForReview(row.id, row.chat_group_id, row.user_id, result)
    return checkAndAutoMute(row.user_id, row.chat_group_id)
  }
  return flagForReview(row.id, row.chat_group_id, row.user_id, result)
}

let timer: ReturnType<typeof setTimeout> | null = null
let stopped = false

async function runRecheck(): Promise<void> {
  try {
    const { looked, settled } = await recheckUncheckedMessages()
    if (looked > 0) logger.info("Moderation re-check", { looked, settled })
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
