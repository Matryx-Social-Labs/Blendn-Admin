// Relative imports: the profile photo checks run from the photo sweeper, which server.ts reaches.
import { auditLog } from "../audit-log"
import { logger } from "../logger"
import { notifyStaff } from "../staff-alert"
import { CHILD_SAFETY_CATEGORY } from "./config"
import type { ModerationCheck } from "./openai-moderation"

/**
 * An image verdict naming `sexual/minors` (SCRUM-1163, launch gate 9).
 *
 * Every image path pulls such a photo through its own hide path (profile and
 * blur photos are withdrawn to the private bucket, a Lobby photo is rejected
 * and stays in it) and then calls this, once, AFTER the pull: it pages staff
 * and leaves the `moderation.child_safety_hold` audit row. What happens next
 * (who reports it, to whom, how long the object is held) is the runbook's
 * (`docs/MODERATION_RESPONSE.md`), with the hold length for the lawyer to confirm.
 *
 * The page leaves the platform, so it carries the storage key and the user id
 * only: no URL (a signed one is a bearer link to the image), no image, no name.
 * Never throws: nothing here may stop, or undo, the pull.
 */
export async function escalateChildSafetyImage(check: ModerationCheck, objectKey: string | null, userId: string): Promise<void> {
  // `?.` on categories: this runs in a `finally`, where a throw would replace the pull's own error.
  if (!check.checked || check.result?.action !== "hide" || check.result.categories?.[CHILD_SAFETY_CATEGORY] === undefined) return
  const context = { userId, objectKey }
  try {
    // No actor: the platform did this (lib/audit-log.ts `actsFor`), as for every automated row.
    auditLog({
      action: "moderation.child_safety_hold",
      resource: "user",
      resourceId: userId,
      details: { objectKey, category: CHILD_SAFETY_CATEGORY },
    })
  } catch (error) {
    logger.error("Child-safety image hold: audit row not written", { ...context, error: error instanceof Error ? error.message : String(error) })
  }
  const result = await notifyStaff(`Child-safety image hold (${CHILD_SAFETY_CATEGORY}).\nUser: ${userId}\nObject key: ${objectKey}`)
  if (result !== "sent") logger.error("Child-safety image hold: staff were not paged", { ...context, result })
}
