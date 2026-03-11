import type { ModerationResult, OpenAIModerationCategory } from "./types"
import { AUTO_HIDE_THRESHOLD, FLAG_THRESHOLD } from "./config"
import { logger } from "@/lib/logger"

const OPENAI_MODERATION_URL = "https://api.openai.com/v1/moderations"

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
 * Check text content with OpenAI Moderation API.
 * Returns null if content is clean or API is unavailable.
 * Fails open: returns null on any error.
 */
export async function checkTextContent(
  content: string
): Promise<ModerationResult | null> {
  const apiKey = getApiKey()
  if (!apiKey) {
    logger.debug("OpenAI API key not configured, skipping text moderation")
    return null
  }

  try {
    const response = await fetch(OPENAI_MODERATION_URL, {
      method: "POST",
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
      return null // Fail open
    }

    const data = await response.json()
    const result = data.results?.[0]
    if (!result) return null

    return evaluateScores(
      result.category_scores as OpenAIModerationCategory,
      result.flagged as boolean,
      "openai_text"
    )
  } catch (error) {
    logger.error("OpenAI Moderation API call failed", { error: String(error) })
    return null // Fail open
  }
}

/**
 * Check image content with OpenAI Moderation API.
 * Returns null if content is clean or API is unavailable.
 * Fails open: returns null on any error.
 */
export async function checkImageContent(
  imageUrl: string
): Promise<ModerationResult | null> {
  const apiKey = getApiKey()
  if (!apiKey) {
    logger.debug("OpenAI API key not configured, skipping image moderation")
    return null
  }

  try {
    const response = await fetch(OPENAI_MODERATION_URL, {
      method: "POST",
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
      return null // Fail open
    }

    const data = await response.json()
    const result = data.results?.[0]
    if (!result) return null

    return evaluateScores(
      result.category_scores as OpenAIModerationCategory,
      result.flagged as boolean,
      "openai_image"
    )
  } catch (error) {
    logger.error("OpenAI Image Moderation API call failed", { error: String(error) })
    return null // Fail open
  }
}
