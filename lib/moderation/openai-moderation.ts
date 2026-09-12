import { logger } from "@/lib/logger"
import type { ModerationResult, OpenAIModerationCategory } from "./types"
import { AUTO_HIDE_THRESHOLD, FLAG_THRESHOLD } from "./config"

const OPENAI_MODERATION_URL = "https://api.openai.com/v1/moderations"

/**
 * Did we actually look at this, and what did we see.
 *
 * ## Why `null` was not good enough
 *
 * Both checks returned `ModerationResult | null`, and `null` carried **four**
 * different facts: the content is clean, `OPENAI_API_KEY` is unset, the API
 * errored, and — in the inline path's `Promise.race` — the check timed out.
 * Only the first of those means the message was examined.
 *
 * The caller could not tell them apart, so it wrote `moderation_status: "clean"`
 * for all four. **An unchecked message was recorded as checked and clean**, and
 * `OPENAI_API_KEY` is marked optional in `lib/env.ts` and listed as not required
 * in `DEPLOYMENT.md` — so the ordinary deployment records every message as
 * moderated by a moderator that was never called.
 *
 * A moderator reading that column cannot distinguish a room nobody has abused
 * from a pipeline that has been down for a week.
 *
 * ## The rule
 *
 * Deliver, but never call something clean that was not checked. `unchecked` is a
 * real state with a real reader — the moderation screen's degraded count — which
 * is what makes a broken pipeline actionable instead of silent. R13.
 *
 * The deterministic checks (keyword, spam, contact-info) are not subject to this:
 * they need no external service, so they cannot fail open.
 */
export type ModerationCheck =
  /** We looked. `result` is null when the content is clean. */
  | { checked: true; result: ModerationResult | null }
  /** We did not look, and this is why. */
  | { checked: false; reason: "no_key" | "error" | "timeout" }

/** The check never ran. Exported so the timeout path can say so too. */
export function notChecked(reason: "no_key" | "error" | "timeout"): ModerationCheck {
  return { checked: false, reason }
}

function getApiKey(): string | undefined {
  return process.env.OPENAI_API_KEY
}

/**
 * Map OpenAI category scores to a ModerationResult.
 * Returns null if content is clean.
 */
function evaluateScores(
  scores: OpenAIModerationCategory,
  flagged: boolean,
  source: "openai_text" | "openai_image"
): ModerationResult | null {
  // Find the highest-scoring category
  const entries = Object.entries(scores) as [string, number][]
  const maxEntry = entries.reduce((a, b) => (b[1] > a[1] ? b : a))
  const [, maxScore] = maxEntry

  // Filter to categories above the flag threshold
  const categories: Record<string, number> = {}
  for (const [key, value] of entries) {
    if (value >= FLAG_THRESHOLD) {
      categories[key] = value
    }
  }

  // If nothing above threshold and OpenAI didn't flag, it's clean
  if (!flagged && maxScore < FLAG_THRESHOLD) return null

  const confidence = maxScore

  return {
    action: confidence >= AUTO_HIDE_THRESHOLD ? "hide" : "flag",
    source,
    categories: Object.keys(categories).length > 0 ? categories : { [maxEntry[0]]: maxScore },
    confidence,
  }
}

/**
 * Check text content with the OpenAI Moderation API.
 *
 * Still delivers on failure -- refusing to send a message because a third-party
 * API is down is its own harm -- but says so, rather than reporting clean.
 */
/**
 * How long a vendor call may hold a request.
 *
 * Neither fetch here had a deadline. The text check sits on the chat send
 * path and the image check sat on the profile PUT, so a stalled OpenAI call
 * held the person's request until Node's own timeout — minutes — while the
 * mobile client gave up at 15 s and showed "taking too long", and the write
 * then landed anyway from the abandoned request. A timeout is just another
 * branch of the "error" path this file already degrades through.
 */
export const MODERATION_TIMEOUT_MS = 8_000

/** `AbortSignal.timeout` rejects the fetch with a DOMException named TimeoutError. */
const abortedByTimeout = (error: unknown) =>
  error instanceof Error && error.name === "TimeoutError"

export async function checkTextContent(content: string): Promise<ModerationCheck> {
  const apiKey = getApiKey()
  if (!apiKey) {
    logger.debug("OpenAI API key not configured, skipping text moderation")
    return notChecked("no_key")
  }

  try {
    const response = await fetch(OPENAI_MODERATION_URL, {
      method: "POST",
      signal: AbortSignal.timeout(MODERATION_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "omni-moderation-latest",
        input: content,
      }),
    })

    if (!response.ok) {
      logger.warn("OpenAI Moderation API returned non-OK status", {
        status: response.status,
        statusText: response.statusText,
      })
      return notChecked("error")
    }

    const data = await response.json()
    const result = data.results?.[0]
    if (!result) return notChecked("error")

    return {
      checked: true,
      result: evaluateScores(
        result.category_scores as OpenAIModerationCategory,
        result.flagged as boolean,
        "openai_text"
      ),
    }
  } catch (error) {
    logger.error("OpenAI Moderation API call failed", { error: String(error) })
    return notChecked(abortedByTimeout(error) ? "timeout" : "error")
  }
}

/**
 * Check image content with the OpenAI Moderation API. Same contract as
 * `checkTextContent`: delivers on failure, and says it did not look.
 */
export async function checkImageContent(imageUrl: string): Promise<ModerationCheck> {
  const apiKey = getApiKey()
  if (!apiKey) {
    logger.debug("OpenAI API key not configured, skipping image moderation")
    return notChecked("no_key")
  }

  try {
    const response = await fetch(OPENAI_MODERATION_URL, {
      method: "POST",
      signal: AbortSignal.timeout(MODERATION_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "omni-moderation-latest",
        input: [
          {
            type: "image_url",
            image_url: { url: imageUrl },
          },
        ],
      }),
    })

    if (!response.ok) {
      logger.warn("OpenAI Image Moderation API returned non-OK status", {
        status: response.status,
        statusText: response.statusText,
      })
      return notChecked("error")
    }

    const data = await response.json()
    const result = data.results?.[0]
    if (!result) return notChecked("error")

    return {
      checked: true,
      result: evaluateScores(
        result.category_scores as OpenAIModerationCategory,
        result.flagged as boolean,
        "openai_image"
      ),
    }
  } catch (error) {
    logger.error("OpenAI Image Moderation API call failed", { error: String(error) })
    return notChecked(abortedByTimeout(error) ? "timeout" : "error")
  }
}
