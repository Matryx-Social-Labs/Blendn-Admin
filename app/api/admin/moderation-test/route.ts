import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth"
import { checkKeywords } from "@/lib/moderation/keyword-filter"
import { AUTO_HIDE_THRESHOLD, FLAG_THRESHOLD } from "@/lib/moderation/config"

export const dynamic = "force-dynamic"

const OPENAI_MODERATION_URL = "https://api.openai.com/v1/moderations"

/**
 * Admin-only endpoint to test moderation pipeline.
 * GET /api/admin/moderation-test?text=your+test+message
 *
 * Returns RAW OpenAI API response + keyword filter results
 * to diagnose why moderation may not be working.
 */
export async function GET(request: NextRequest) {
  // Admin auth check
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const text = request.nextUrl.searchParams.get("text")
  if (!text) {
    return NextResponse.json(
      { error: "Missing ?text= parameter", usage: "GET /api/admin/moderation-test?text=your+test+message" },
      { status: 400 }
    )
  }

  const apiKey = process.env.OPENAI_API_KEY

  const results: Record<string, unknown> = {
    input: text,
    config: {
      AUTO_HIDE_THRESHOLD,
      FLAG_THRESHOLD,
      OPENAI_API_KEY_SET: !!apiKey,
      OPENAI_API_KEY_PREFIX: apiKey ? apiKey.slice(0, 12) + "..." : "NOT SET",
      OPENAI_API_KEY_LENGTH: apiKey?.length ?? 0,
    },
    stages: {},
  }

  // Stage 1: Keyword filter
  try {
    const keywordResult = checkKeywords(text)
    results.stages = {
      ...results.stages as object,
      keyword_filter: keywordResult
        ? { triggered: true, ...keywordResult }
        : { triggered: false, result: "clean" },
    }
  } catch (error) {
    results.stages = {
      ...results.stages as object,
      keyword_filter: { error: String(error) },
    }
  }

  // Stage 2: Raw OpenAI moderation call (bypassing our wrapper to see full response)
  if (!apiKey) {
    results.stages = {
      ...results.stages as object,
      openai_raw: { error: "OPENAI_API_KEY not set" },
    }
  } else {
    try {
      const startTime = Date.now()
      const response = await fetch(OPENAI_MODERATION_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "omni-moderation-latest",
          input: text,
        }),
      })

      const duration = Date.now() - startTime
      const rawBody = await response.text()

      let parsed: unknown = null
      try {
        parsed = JSON.parse(rawBody)
      } catch {
        // keep as raw text
      }

      if (!response.ok) {
        results.stages = {
          ...results.stages as object,
          openai_raw: {
            error: "API returned non-OK",
            status: response.status,
            statusText: response.statusText,
            duration_ms: duration,
            response_body: parsed ?? rawBody.slice(0, 500),
          },
        }
      } else {
        const data = parsed as Record<string, unknown>
        const firstResult = (data?.results as Array<Record<string, unknown>>)?.[0]

        // Show the full raw scores
        results.stages = {
          ...results.stages as object,
          openai_raw: {
            duration_ms: duration,
            model: data?.model,
            flagged: firstResult?.flagged,
            categories: firstResult?.categories,
            category_scores: firstResult?.category_scores,
          },
        }

        // Show which scores exceed our thresholds
        if (firstResult?.category_scores) {
          const scores = firstResult.category_scores as Record<string, number>
          const aboveHide: Record<string, number> = {}
          const aboveFlag: Record<string, number> = {}
          for (const [key, value] of Object.entries(scores)) {
            if (value >= AUTO_HIDE_THRESHOLD) aboveHide[key] = value
            else if (value >= FLAG_THRESHOLD) aboveFlag[key] = value
          }
          results.threshold_analysis = {
            would_auto_hide: Object.keys(aboveHide).length > 0,
            scores_above_hide_threshold: aboveHide,
            would_flag: Object.keys(aboveFlag).length > 0,
            scores_above_flag_threshold: aboveFlag,
            max_score: Math.max(...Object.values(scores)),
            max_category: Object.entries(scores).reduce((a, b) => b[1] > a[1] ? b : a, ["", 0])[0],
          }
        }
      }
    } catch (error) {
      results.stages = {
        ...results.stages as object,
        openai_raw: { error: String(error) },
      }
    }
  }

  return NextResponse.json(results, { status: 200 })
}
