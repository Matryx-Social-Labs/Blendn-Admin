// Relative imports: the profile photo checks run from the photo sweeper, which server.ts reaches.
import { auditInTx } from "../audit-log"
import { db } from "../db"
import { dashboardUrl } from "../email"
import { logger } from "../logger"
import { notifyStaff, type StaffNotice } from "../staff-alert"
import type { ModerationCheck } from "./openai-moderation"

/** Where the pulled image was. */
export type ImagePath = "profile" | "blur" | "lobby"

/**
 * One page per user per 10 minutes: one account uploading image after image
 * must not bury the next real case. Every pull still writes its audit row.
 * The cooldown is kept in this process's memory.
 */
const PAGE_COOLDOWN_MS = 10 * 60 * 1000
const lastPaged = new Map<string, number>()

/**
 * A sexual image that moderation pulled goes to a person, who looks for a minor
 * or a non-consensual image (SCRUM-1163).
 *
 * Called by each image path AFTER its own pull (profile and blur photos are
 * withdrawn to the private bucket, a Lobby photo is rejected and stays in it):
 * one audit row, `moderation.sexual_image_hold`, and one page (at most one per
 * user per 10 minutes). The page leaves the platform, so it carries the storage
 * key and the user id: no URL (a signed one is a bearer link to the image), no
 * image, no name. Never throws: nothing here may stop, or undo, the pull.
 */
export async function holdSexualImage(check: ModerationCheck, path: ImagePath, objectKey: string | null, userId: string): Promise<void> {
  const context = { userId, objectKey }
  try {
    const categories = check.checked && check.result?.action === "hide" && check.result.source === "openai_image" ? check.result.categories : undefined
    const category = (["sexual/minors", "sexual"] as const).find((c) => categories?.[c] !== undefined)
    if (!category) return
    if (!objectKey) logger.error("Sexual image hold: the object key could not be resolved", context)
    // No actor: the platform did this (lib/audit-log.ts `actsFor`). Awaited, so a lost row is logged here, with whose it was.
    const audited = await db
      .$transaction((tx) => auditInTx(tx, { action: "moderation.sexual_image_hold", resource: "user", resourceId: userId, details: { objectKey, path, category } }))
      .then(() => true)
      .catch((error: unknown) => {
        logger.error("Sexual image hold: audit row not written", { ...context, error: error instanceof Error ? error.message : String(error) })
        return false
      })
    const now = Date.now()
    for (const [id, at] of lastPaged) if (now - at >= PAGE_COOLDOWN_MS) lastPaged.delete(id)
    // The cooldown leaves a pull to its audit row; one whose row was lost is paged regardless.
    if (audited && lastPaged.has(userId)) {
      logger.info("Sexual image page held back by the 10-minute cooldown", { ...context, path })
      return
    }
    // Taken before the send, so a second pull arriving during it waits out the window too; given back unless a page went.
    lastPaged.set(userId, now)
    let result: StaffNotice | undefined
    try {
      result = await notifyStaff(
        `Sexual image pulled (${path}). A person must check it for a minor or a non-consensual image. key ${objectKey} user ${userId}\n` +
          `More from this user in the next 10 minutes go to the audit log only.\n${dashboardUrl()}/dashboard/moderation`
      )
    } finally {
      if (result !== "sent") lastPaged.delete(userId)
    }
    if (result !== "sent") logger.error("Sexual image hold: staff were not paged", { ...context, result })
  } catch (error) {
    logger.error("Sexual image hold failed", { ...context, error: error instanceof Error ? error.message : String(error) })
  }
}
