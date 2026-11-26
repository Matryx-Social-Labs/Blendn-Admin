// Relative imports: started from server.ts via background.ts, which
// `build:server` compiles with plain tsc -- the `@/` alias would be emitted verbatim.
import { db } from "./db"
import { dashboardUrl } from "./email"
import { logger } from "./logger"
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
 *
 * ponytail: without a readable Redis mark, a new process's first window is one
 * interval wide, ending COMMIT_GRACE_MS before boot, so a report written while
 * no process was up for longer than that is not announced (it is still in the
 * queue). Railway overlaps the old and new containers on a deploy; set REDIS_URL
 * if crashes with long gaps matter. One replica at launch: two would each announce.
 */
const STAFF_ALERT_INTERVAL_MS = 60_000
/** The window trails now by this much: a row whose transaction commits after the count is in the next window, not lost. */
const COMMIT_GRACE_MS = 5_000
/** Room lines delivered unchecked in the last hour above which the message says moderation is degraded (the breaker stuck open). */
export const DEGRADED_UNCHECKED_PER_HOUR = 20
/** A pending flag this confident is severe whatever its category (the dashboard's high-confidence line). */
const SEVERE_CONFIDENCE = 0.9
/** Category keys (OpenAI's, and their sub-keys) that make a pending flag severe at any confidence. */
const SEVERE_CATEGORY_PREFIXES = ["violence", "self-harm", "sexual/minors", "harassment/threatening"]

const MARK_KEY = "staff-alert:mark"
const HOUR_MS = 60 * 60 * 1000

export type StaffNotice = "sent" | "unconfigured" | "failed"

/** Tell staff something now, in counts and links only (task 03 pages through this). Never throws. */
export async function notifyStaff(text: string): Promise<StaffNotice> {
  const channels = channelsFrom("STAFF_ALERT_SLACK_WEBHOOK_URL", "STAFF_ALERT_EMAIL")
  if (!channels) {
    logger.info("Staff alert not sent, no channel configured", {
      text,
      hint: "set STAFF_ALERT_SLACK_WEBHOOK_URL or STAFF_ALERT_EMAIL",
    })
    return "unconfigured"
  }
  const sent = await sendToChannels(channels, { subject: "Blendn: moderation needs a look", text }, { alert: "staff" })
  return sent ? "sent" : "failed"
}

let memoryMark: Date | null = null
let saidDegraded = false

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
  const [row] = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM moderation_flags
     WHERE status = 'pending'
       AND created_at > ${since} AND created_at <= ${until}
       AND (confidence >= ${SEVERE_CONFIDENCE}
            OR CASE WHEN jsonb_typeof(categories) = 'object'
                 THEN EXISTS (SELECT 1 FROM jsonb_object_keys(categories) k WHERE k LIKE ANY (${patterns}))
                 ELSE false END)`
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
    const [users, messages, events, severe, unchecked] = await Promise.all([
      db.user_reports.count({ where: pending }),
      db.message_reports.count({ where: pending }),
      // ponytail: event_reports has (status) only, so this reads every pending one; add (status, created_at) if they pile up.
      db.event_reports.count({ where: pending }),
      severeFlags(since, until),
      // `deleted_at: null` so the partial index chat_messages_unchecked_idx serves it.
      db.chat_messages.count({
        where: { moderation_status: "unchecked", deleted_at: null, created_at: { gte: new Date(now.getTime() - HOUR_MS) } },
      }),
    ])
    const reports = users + messages + events
    const degraded = unchecked > DEGRADED_UNCHECKED_PER_HOUR

    if (reports > 0 || severe > 0 || (degraded && !saidDegraded)) {
      const lines: string[] = []
      if (reports > 0 || severe > 0) {
        const oldest = await oldestPending()
        const counts = [reports > 0 && plural(reports, "new report"), severe > 0 && plural(severe, "severe flag")]
        lines.push(
          `${counts.filter(Boolean).join(", ")}${oldest ? `; oldest pending ${age(now.getTime() - oldest.getTime())}` : ""}.`
        )
      }
      if (degraded) lines.push(`Moderation degraded: ${plural(unchecked, "room line")} unchecked in the last hour.`)
      lines.push(`${dashboardUrl()}/dashboard/moderation`)
      if ((await notifyStaff(lines.join("\n"))) === "failed") return
    }

    saidDegraded = degraded
    memoryMark = until
    await writeMark(MARK_KEY, until.toISOString())
  } catch (error) {
    logger.error("Staff alert sweep failed", { error: error instanceof Error ? error.message : String(error) })
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
  // Boot is when a restart's gap gets announced.
  void runStaffAlertSweep().finally(schedule)
}

export function stopStaffAlertSweeper(): void {
  stopped = true
  running = false
  if (timer) clearTimeout(timer)
  timer = null
}
