// Relative imports: this is reached from `lib/background.ts`, which `server.ts`
// requires, and `build:server` compiles with plain tsc — which emits the `@/`
// alias verbatim into the require() and fails at boot.
import { logger } from "./logger"
import { cleanupExpiredTokens } from "./mobile-auth"
import { sendEventReminders } from "./services/event-notifications.service"

/**
 * The reminder people were promised, and the tokens nobody pruned.
 *
 * `sendEventReminders` existed, was correct about its audience, and had a cron
 * route in front of it — and **nothing called that route**. There is no cron
 * block in `railway.json` and no scheduled workflow, so the one notification
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
  /*
   * 60 minutes, matching the cron route's argument. The client also schedules a
   * local T-1h notification, so this is the server's half of a promise the app
   * already makes — and the server's half is the one that can be corrected
   * when an event moves.
   */
  const notified = await sendEventReminders(60)
  if (notified > 0) logger.info("Event reminders sent", { notified })

  const pruned = await cleanupExpiredTokens()
  if (pruned > 0) logger.info("Expired refresh tokens pruned", { pruned })
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
