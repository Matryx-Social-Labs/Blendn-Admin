// Relative imports: started from server.ts via background.ts, which
// `build:server` compiles with plain tsc -- the `@/` alias would be emitted verbatim.
import { db } from "./db"
import { dashboardUrl } from "./email"
import { beat } from "./heartbeat"
import { logger } from "./logger"
import { SEVERE_CATEGORY_PREFIXES, UNJUDGED_KEY } from "./moderation/config"
import { MODERATION_TIMEOUT_MS } from "./moderation/openai-moderation"
import { channelsFrom, sendToChannels } from "./notify-channels"
import { readMark, writeMark } from "./rate-limit-store"

/**
 * Staff hear about reports and severe flags (SCRUM-1161, launch gate 9).
 *
 * Ten places write `user_reports`, `message_reports` and `event_reports`, and
 * none told anybody: a threat reported at 23:00 was read on Monday. Rather than
 * a notifier in each writer (and the eleventh writer forgetting it), one sweep
 * counts what is new every minute and posts ONE message over the lead alert's
 * channels (`STAFF_ALERT_SLACK_WEBHOOK_URL` and/or `STAFF_ALERT_EMAIL`).
 *
 * The message carries counts, the oldest pending age and a dashboard link only.
 * It leaves the platform: no names, no ids of people, no message content.
 *
 * "New" is a window: (the last run's upper bound, now - COMMIT_GRACE_MS]. The
 * mark advances only once the message went out (or there was nothing to say,
 * or no channel to say it on), so a failing channel repeats next minute and a
 * restart repeats at most one message. The mark is kept in Redis when there is
 * one, and in memory too (the later of the two wins, so a Redis write that
 * failed never re-announces an old window).
 */
const STAFF_ALERT_INTERVAL_MS = 60_000
/**
 * The window trails now by this much: a row's created_at is its transaction's
 * start, so one that commits after the count is in the next window, not lost.
 * Two writers create reports inside a transaction, and Prisma ends an
 * interactive one at 5 s; 10 s is that with room.
 */
const COMMIT_GRACE_MS = 10_000
/** More `unchecked` room lines than this in the last hour, and the message says moderation is degraded. */
export const DEGRADED_UNCHECKED_PER_HOUR = 20
/** A pending flag this confident is severe whatever its category (the dashboard's high-confidence line). */
const SEVERE_CONFIDENCE = 0.9
/**
 * A swear-word hide the model has not judged is said on a line of its own, at
 * most once in this long; the count then is every one since it was last said.
 */
const UNJUDGED_REPEAT_MS = 15 * 60 * 1000
/**
 * The unjudged count trails the window by this much more: `recordHide` asks the
 * model up to twice after the flag is written, and a flag whose answer is still
 * on its way is not yet a line the model could not judge.
 */
const UNJUDGED_SETTLE_MS = 2 * MODERATION_TIMEOUT_MS

const MARK_KEY = "staff-alert:mark"
const HOUR_MS = 60 * 60 * 1000

export type StaffNotice = "sent" | "unconfigured" | "failed"

/** Tell staff something now: the sweep's counts, or a pulled image's page (`moderation/sexual-image-hold.ts`). Never throws. */
export async function notifyStaff(text: string): Promise<StaffNotice> {
  const channels = channelsFrom("STAFF_ALERT_SLACK_WEBHOOK_URL", "STAFF_ALERT_EMAIL")
  if (!channels) {
    // An error in production, an info line elsewhere.
    const log = process.env.RAILWAY_ENVIRONMENT_NAME === "production" ? logger.error : logger.info
    log("Staff alert not sent, no channel configured", {
      hint: "set STAFF_ALERT_SLACK_WEBHOOK_URL, or STAFF_ALERT_EMAIL with RESEND_API_KEY and EMAIL_FROM",
    })
    return "unconfigured"
  }
  const sent = await sendToChannels(channels, { subject: "Blendn: moderation needs a look", text }, { alert: "staff" })
  return sent ? "sent" : "failed"
}

let memoryMark: Date | null = null
let saidDegraded = false
/** The upper bound of the last unjudged count that went out; null since boot. */
let unjudgedSaidUntil: Date | null = null

async function lastMark(now: Date): Promise<Date> {
  const stored = await readMark(MARK_KEY)
  const fromRedis = stored ? new Date(stored) : null
  if (fromRedis && !Number.isNaN(fromRedis.getTime()) && (!memoryMark || fromRedis > memoryMark)) return fromRedis
  // Pinned at the first run, not recomputed: a first post that fails must keep its window.
  memoryMark ??= new Date(now.getTime() - STAFF_ALERT_INTERVAL_MS - COMMIT_GRACE_MS)
  return memoryMark
}

async function severeFlags(since: Date, until: Date): Promise<number> {
  const patterns = SEVERE_CATEGORY_PREFIXES.map((p) => `${p}%`)
  // CASE, not AND: SQL does not promise to short-circuit, and jsonb_object_keys
  // raises on the sentiment sweeper's array-shaped categories.
  // A flag whose only key is `profanity` (the keyword list's swear-word hide,
  // lib/moderation/keyword-filter.ts), or `profanity` and the not-yet-judged
  // key (`unjudgedHides` below), is not severe by confidence; such flags are
  // also left out of the auto-mute count (abuseHiddenCount in
  // lib/moderation/actions.ts). Any other key beside it keeps the flag severe.
  // The comparisons never raise: `->` gives NULL on an array or a scalar.
  const [row] = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM moderation_flags
     WHERE status = 'pending'
       AND created_at > ${since} AND created_at <= ${until}
       AND ((confidence >= ${SEVERE_CONFIDENCE}
             AND categories <> jsonb_build_object('profanity', categories -> 'profanity')
             AND categories <> jsonb_build_object('profanity', categories -> 'profanity', ${UNJUDGED_KEY}::text, categories -> ${UNJUDGED_KEY}::text))
            OR CASE WHEN jsonb_typeof(categories) = 'object'
                 THEN EXISTS (SELECT 1 FROM jsonb_object_keys(categories) k WHERE k LIKE ANY (${patterns}))
                 ELSE false END)`
  return row?.n ?? 0
}

/** Pending flags that are exactly `{profanity, unjudged}`: swear-word hides `recordHide` has not marked judged. */
async function unjudgedHides(since: Date, until: Date): Promise<number> {
  const [row] = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM moderation_flags
     WHERE status = 'pending'
       AND created_at > ${since} AND created_at <= ${until}
       AND categories = jsonb_build_object('profanity', categories -> 'profanity', ${UNJUDGED_KEY}::text, categories -> ${UNJUDGED_KEY}::text)`
  return row?.n ?? 0
}

/** The oldest thing waiting in either queue, asked only when there is something to say. */
async function oldestPending(): Promise<Date | null> {
  const [row] = await db.$queryRaw<{ oldest: Date | null }[]>`
    SELECT LEAST(
      (SELECT min(created_at) FROM user_reports WHERE status = 'pending'),
      (SELECT min(created_at) FROM message_reports WHERE status = 'pending'),
      (SELECT min(created_at) FROM event_reports WHERE status = 'pending'),
      (SELECT min(created_at) FROM moderation_flags WHERE status = 'pending')
    ) AS oldest`
  return row?.oldest ?? null
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

function age(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 120) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`
}

/** One minute's work. Never throws: a failure is logged and the same window is asked again next run. */
export async function runStaffAlertSweep(now: Date = new Date()): Promise<void> {
  try {
    const since = await lastMark(now)
    const until = new Date(now.getTime() - COMMIT_GRACE_MS)
    const pending = { status: "pending" as const, created_at: { gt: since, lte: until } }
    const settled = new Date(until.getTime() - UNJUDGED_SETTLE_MS)
    const repeatFrom = new Date(settled.getTime() - UNJUDGED_REPEAT_MS)
    const mayRepeat = !unjudgedSaidUntil || unjudgedSaidUntil <= repeatFrom
    const [users, messages, events, severe, unjudged, unchecked] = await Promise.all([
      db.user_reports.count({ where: pending }),
      db.message_reports.count({ where: pending }),
      db.event_reports.count({ where: pending }),
      severeFlags(since, until),
      // Its own failure is its own: the reports and severe flags still go out, and the same rows are asked next run.
      mayRepeat
        ? unjudgedHides(unjudgedSaidUntil ?? repeatFrom, settled).catch((error) => {
            logger.error("Staff alert: unjudged count failed", { error: error instanceof Error ? error.message : String(error) })
            return 0
          })
        : 0,
      // `deleted_at: null` so the partial index chat_messages_unchecked_idx serves it.
      db.chat_messages.count({
        where: { moderation_status: "unchecked", deleted_at: null, created_at: { gte: new Date(now.getTime() - HOUR_MS) } },
      }),
    ])
    const reports = users + messages + events
    const degraded = unchecked > DEGRADED_UNCHECKED_PER_HOUR

    if (reports > 0 || severe > 0 || unjudged > 0 || (degraded && !saidDegraded)) {
      const lines: string[] = []
      if (reports > 0 || severe > 0) {
        const oldest = await oldestPending()
        const counts = [reports > 0 && plural(reports, "new report"), severe > 0 && plural(severe, "severe flag")]
        lines.push(
          `${counts.filter(Boolean).join(", ")}${oldest ? `; oldest pending ${age(now.getTime() - oldest.getTime())}` : ""}.`
        )
      }
      if (unjudged > 0) lines.push(`${plural(unjudged, "hidden line")} the model could not judge.`)
      if (degraded) lines.push(`Moderation degraded: ${plural(unchecked, "room line")} unchecked in the last hour.`)
      lines.push(`${dashboardUrl()}/dashboard/moderation`)
      if ((await notifyStaff(lines.join("\n"))) === "failed") return
    }

    saidDegraded = degraded
    if (unjudged > 0) unjudgedSaidUntil = settled
    memoryMark = until
    await writeMark(MARK_KEY, until.toISOString())
    beat("staff-alert", STAFF_ALERT_INTERVAL_MS)
  } catch (error) {
    logger.error("Staff alert sweep failed", {
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    })
  }
}

let timer: ReturnType<typeof setTimeout> | null = null
let running = false
let stopped = false

/** Self-scheduling, like the other sweepers: a slow pass must not overlap the next. */
export function startStaffAlertSweeper(): void {
  if (running) return
  running = true
  stopped = false
  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => {
      void runStaffAlertSweep().finally(schedule)
    }, STAFF_ALERT_INTERVAL_MS)
    timer.unref?.()
  }
  beat("staff-alert", STAFF_ALERT_INTERVAL_MS)
  // Boot is when a restart's gap gets announced.
  void runStaffAlertSweep().finally(schedule)
}

export function stopStaffAlertSweeper(): void {
  stopped = true
  running = false
  if (timer) clearTimeout(timer)
  timer = null
}
