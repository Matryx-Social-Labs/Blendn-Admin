import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth"
import { checkKeywords } from "@/lib/moderation/keyword-filter"
import { checkTextContent } from "@/lib/moderation/openai-moderation"
import { AUTO_HIDE_THRESHOLD, FLAG_THRESHOLD } from "@/lib/moderation/config"

export const dynamic = "force-dynamic"

/**
 * Admin-only endpoint to test moderation pipeline.
 * GET /api/admin/moderation-test?text=your+test+message
 *
 * Returns the results from each moderation stage so you can
 * verify keyword filter and OpenAI moderation are both working.
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

  const results: Record<string, unknown> = {
    input: text,
    config: {
      AUTO_HIDE_THRESHOLD,
      FLAG_THRESHOLD,
      OPENAI_API_KEY_SET: !!process.env.OPENAI_API_KEY,
      OPENAI_API_KEY_PREFIX: process.env.OPENAI_API_KEY?.slice(0, 10) + "...",
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

  // Stage 2: OpenAI text moderation
  try {
    const startTime = Date.now()
    const openaiResult = await checkTextContent(text)
    const duration = Date.now() - startTime
    results.stages = {
      ...results.stages as object,
      openai_moderation: openaiResult
        ? { triggered: true, duration_ms: duration, ...openaiResult }
        : { triggered: false, result: "clean", duration_ms: duration },
    }
  } catch (error) {
    results.stages = {
      ...results.stages as object,
      openai_moderation: { error: String(error) },
    }
  }

  // Final verdict
  const keyword = (results.stages as Record<string, { triggered?: boolean; action?: string }>).keyword_filter
  const openai = (results.stages as Record<string, { triggered?: boolean; action?: string }>).openai_moderation

  let verdict = "clean"
  if (keyword?.triggered && keyword?.action === "hide") verdict = "auto-hide (keyword)"
  else if (openai?.triggered && openai?.action === "hide") verdict = "auto-hide (openai)"
  else if (keyword?.triggered && keyword?.action === "flag") verdict = "flag for review (keyword)"
  else if (openai?.triggered && openai?.action === "flag") verdict = "flag for review (openai)"

  results.verdict = verdict

  return NextResponse.json(results, { status: 200 })
}
