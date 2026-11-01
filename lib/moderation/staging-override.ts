import { logger } from "../logger"
import type { ModerationCheck } from "./openai-moderation"

/*
 * A staging-only moderation override (SCRUM-479, owner ruling A-13, 2026-11-01).
 *
 * Staging cannot make the vendor return a real `hide`, so a pulled photo, a hidden message and the auto-mute behind it
 * could never be driven there. MODERATION_FORCE_HIDE_USER_IDS (comma-separated user ids, QA accounts only) makes every
 * checked message and profile photo of those accounts a `hide`, through the same code a real verdict takes.
 *
 * Refused on production whatever is set: RAILWAY_ENVIRONMENT_NAME=production answers null before the list is read.
 */
export function forcedHide(userId: string): ModerationCheck | null {
  if (process.env.RAILWAY_ENVIRONMENT_NAME === "production") return null
  const listed = (process.env.MODERATION_FORCE_HIDE_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  if (!userId || !listed.includes(userId)) return null
  logger.warn("Staging moderation override: judged hide", { userId })
  return {
    checked: true,
    result: { action: "hide", source: "openai_image", categories: { staging_override: 1 }, confidence: 1, reason: "staging moderation override" },
  }
}
