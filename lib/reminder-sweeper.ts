// Relative imports: this is reached from `lib/background.ts`, which `server.ts`
// requires, and `build:server` compiles with plain tsc — which emits the `@/`
// alias verbatim into the require() and fails at boot.
import { sendFreeWindowEndingMail } from "./free-window-mail"
import { logger } from "./logger"
import { cleanupExpiredTokens } from "./mobile-auth"
import { checkPushReceipts, pruneIdlePushTokens, releaseHeldNotifications } from "./push-notifications"
import { sendResultsMails } from "./results-mail"
import { sendEventReminders, sendRatingRequests } from "./services/event-notifications.service"

/**
 * The reminder people were promised, and the tokens nobody pruned.
 *
 * `sendEventReminders` existed, was correct about its audience, and had a cron
 * route in front of it — and **nothing called that route**. There is no
 * Railway cron and no scheduled workflow, so the one notification
 * the product tells people it sends was never sent by anything.
 *
 * In-process rather than an external cron, matching the five loops already in
 * `lib/background.ts` and for the reason stated there: a job that only runs if
 * somebody remembers to configure a scheduler is a job that stops silently the
 * first time an environment is created without one. The cron route stays, so an
 * external scheduler can still drive it if the deployment ever wants that.
 *
 * `cleanupExpiredTokens` is folded in here rather than given a sixth loop. It
 * has had zero callers since it was written, it is a retention sweep on the
 * same cadence, and a loop per prune is how a process ends up with fifteen
 * timers nobody can account for.
 */
const SWEEP_MS = 5 * 60_000

let timer: NodeJS.Timeout | null = null
let running = false

async function pass(): Promise<void> {
  await pushUpkeep()

  // The host's morning results (SCRUM-1282), the night's figures to the organization's owners and admins. Second, and
  // never throws, so a reminder step that does cannot cost a host their morning mail.
  const mailed = await sendResultsMails()
  if (mailed > 0) logger.info("Results mails sent", { mailed })

  // 60 minutes, matching the cron route's argument. The client schedules no local reminder: this is the only one.
  const notified = await sendEventReminders(60)
  if (notified > 0) logger.info("Event reminders sent", { notified })

  /*
   * The other end of the night: "rate who you met", once per event, at 10:00
   * on the event's clock the morning after it ends. Same claim-before-send
   * idempotency as the reminder, same cadence, so it rides this loop rather
   * than adding a seventh timer.
   */
  const asked = await sendRatingRequests()
  if (asked > 0) logger.info("Rating requests sent", { asked })

  const pruned = await cleanupExpiredTokens()
  if (pruned > 0) logger.info("Expired refresh tokens pruned", { pruned })

  // Last, and caught here (SCRUM-1275): a failing mail never stops or delays the pilot's reminders and ratings above.
  await sendFreeWindowEndingMail().then(
    (orgs) => {
      if (orgs > 0) logger.info("Free-window ending mails sent", { orgs })
    },
    (error: unknown) =>
      logger.warn("Free-window ending mail failed", { error: error instanceof Error ? error.message : String(error) })
  )
}

/**
 * Expo push receipts, idle tokens (SCRUM-1270) and the 09:00 release of held pushes (SCRUM-1276). First, and each step caught:
 * a reminder query that throws must not stop the receipt read, which is the only
 * place wrong FCM or APNs credentials show up. Logs every pass, so a quiet log
 * means the pass did not run.
 */
async function pushUpkeep(): Promise<void> {
  const failed = (step: string) => (error: unknown) =>
    logger.error("Push upkeep failed", { step, error: error instanceof Error ? error.message : String(error) })
  await checkPushReceipts().then((receipts) => logger.info("Push receipts read", { ...receipts }), failed("receipts"))
  await pruneIdlePushTokens().then((idle) => {
    if (idle > 0) logger.info("Idle push tokens pruned", { idle })
  }, failed("prune"))
  // Quiet hours (SCRUM-1276): what was held overnight rings once, at 09:00 on the recipient's clock.
  await releaseHeldNotifications().then((held) => {
    if (held.released > 0) logger.info("Held pushes released", { ...held })
  }, failed("quiet-hours release"))
}

/**
 * Self-scheduling, never `setInterval` — a slow pass must not overlap the next.
 * `lib/socket-server.ts` carries the note about the loop that got this wrong,
 * and a structural test now bans the pattern across `lib/`.
 */
export function startReminderSweeper(): void {
  if (timer) return
  const tick = async () => {
    if (running) return
    running = true
    try {
      await pass()
    } catch (error) {
      logger.error("Reminder sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      running = false
      if (timer) timer = setTimeout(tick, SWEEP_MS).unref()
    }
  }
  timer = setTimeout(tick, SWEEP_MS).unref()
}

export function stopReminderSweeper(): void {
  if (timer) clearTimeout(timer)
  timer = null
}
