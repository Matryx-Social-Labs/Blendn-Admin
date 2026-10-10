import { Prisma } from "@prisma/client"
import { NextRequest } from "next/server"
import { z } from "zod"

import { readJson } from "@/lib/api-input"
import {
  errorResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from "@/lib/api-response"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { isChoice, isQuestion, THIS_OR_THAT } from "@/lib/this-or-that"

/**
 * Your this-or-that answers (plan v2 §8.3) — display only, "you both picked
 * filter coffee over chai". Scoped by construction: `/me`, no id in the path.
 *
 * GET answers `{ answers: { [question]: "a" | "b" } }` for the questions still
 * asked (`GET /profile-options`); a retired question's answer is not listed.
 *
 * PUT takes `{ answers: { [question]: "a" | "b" | null } }`: a choice sets
 * that answer, `null` takes it back, a question not sent is left alone. An
 * unknown question or choice refuses the whole request, so nothing is half
 * saved and nothing is silently dropped.
 */

const putSchema = z.object({
  answers: z
    .record(
      z.string().refine(isQuestion, { message: "Not a this-or-that question" }),
      z.string().refine(isChoice, { message: "Answer \"a\" or \"b\"" }).nullable()
    )
    .refine((a) => Object.keys(a).length <= THIS_OR_THAT.length, { message: "Too many answers" }),
})

async function answersOf(userId: string) {
  const rows = await db.this_or_that_answers.findMany({
    where: { user_id: userId, question: { in: THIS_OR_THAT.map((q) => q.slug) } },
    select: { question: true, choice: true },
  })
  return Object.fromEntries(rows.map((r) => [r.question, r.choice]))
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Authentication required")
    return successResponse({ answers: await answersOf(user.userId) })
  } catch (error) {
    logger.error("Get this-or-that error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get your answers")
  }
}

export async function PUT(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Authentication required")
    const limited = await rateLimit(request, userLimit("write", "this-or-that", user.userId))
    if (limited) return limited

    const parsed = putSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)

    const entries = Object.entries(parsed.data.answers)
    const cleared = entries.filter(([, c]) => c === null).map(([q]) => q)
    const set = entries.flatMap(([question, choice]) => (choice === null ? [] : [[question, choice] as const]))
    const now = new Date()
    await db.$transaction([
      db.this_or_that_answers.deleteMany({ where: { user_id: user.userId, question: { in: cleared } } }),
      ...set.map(([question, choice]) =>
        db.this_or_that_answers.upsert({
          where: { user_id_question: { user_id: user.userId, question } },
          create: { user_id: user.userId, question, choice },
          update: { choice, answered_at: now },
        })
      ),
    ])
    return successResponse({ answers: await answersOf(user.userId) })
  } catch (error) {
    // No profile row yet (an account mid-signup): the answers hang off it.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
      return errorResponse("Finish setting up your profile first", 409, "PROFILE_REQUIRED")
    }
    logger.error("Put this-or-that error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to save your answers")
  }
}
