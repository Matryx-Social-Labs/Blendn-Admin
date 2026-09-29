import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { blockedEitherWay } from "@/lib/conversations"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { identityForRef } from "@/lib/identity"
import { userIdFromRef } from "@/lib/room-handle"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
  serverErrorResponse,
  errorResponse,
} from "@/lib/api-response"
import { addInterestsSchema, removeInterestsSchema } from "@/lib/validations/profile"
import { MAX_INTERESTS, PAGINATION } from "@/lib/constants"
import { readJson } from "@/lib/api-input"

interface RouteParams {
  params: Promise<{ userId: string }>
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    // A room handle or a raw id (SCRUM-371). POST and DELETE stay self-only
    // on the raw id: nobody edits someone else's interests through a handle.
    const ref = (await params).userId
    const userId = userIdFromRef(ref)

    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    // The same answer as the profile and the card: a block, either way, and
    // this person does not exist to you (SCRUM-299). This read never asked, so
    // the person you blocked could still see what you are into, and when you
    // added it.
    if (authUser.userId !== userId && (await blockedEitherWay(authUser.userId, userId))) {
      return notFoundResponse("User not found")
    }

    /*
     * Through a room handle, only for somebody that room shows by name. The
     * room card shows interests you share, never the whole list, and the whole
     * list is the same in every room: a viewer who has seen this person named
     * elsewhere could match it to the pseudonym. So a room that keeps them
     * anonymous gets an empty list here, as the profile routes withhold it.
     * A raw id is unchanged.
     */
    const { room, identified } = await identityForRef(authUser.userId, ref)
    if (room && !identified) return successResponse({ interests: [] })

    // Fetch user interests
    const interests = await db.user_interests.findMany({
      where: { user_id: userId },
      include: {
        category: true,
      },
      take: PAGINATION.MAX_LIMIT,
    })

    return successResponse({
      interests: interests.map((ui) => ({
        id: ui.category.id,
        name: ui.category.name,
        slug: ui.category.slug,
        description: ui.category.description,
        icon: ui.category.icon,
        addedAt: ui.created_at,
      })),
    })
  } catch (error) {
    logger.error("Get interests error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get interests")
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { userId } = await params

    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const limited = await rateLimit(request, userLimit("write", "profile-interests", authUser.userId))
    if (limited) return limited

    // Users can only update their own interests
    if (authUser.userId !== userId) {
      return forbiddenResponse("Cannot update another user's interests")
    }

    const body = await readJson(request)

    // Validate input
    const parsed = addInterestsSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { categoryIds } = parsed.data

    /*
     * The cap, enforced here for the first time.
     *
     * `components/InterestPicker.tsx` has always told the user "the server
     * rejects more than this per call". It did not — there was no cap anywhere
     * in this route, and the only thing holding the line was a client constant
     * anyone could edit out.
     *
     * It matters more now than it did. The ranking is a sum of IDF weights over
     * shared interests, and IDF damps *a category many people hold* — it does
     * nothing about *one person holding many categories*. Someone who ticks all
     * 67 leaves barely moves any holder count, shares an interest with
     * everybody, and surfaces at the top of every list in the room. The damping
     * only arrives once enough people copy them, so the first person to do it is
     * rewarded.
     *
     * Counted against what they will hold *afterwards*, not what this call
     * sends: `createMany` is additive, so ten calls of one would otherwise walk
     * straight past a per-call limit.
     *
     * And counted on the ids that are actually new. The write below is
     * `skipDuplicates`, so re-sending something already held is a no-op — a
     * naive `held + sent` would refuse a save that changes nothing, which is
     * exactly what a client re-submitting an unchanged form does.
     */
    const heldIds = new Set(
      (
        await db.user_interests.findMany({
          where: { user_id: userId },
          select: { category_id: true },
        })
      ).map((r) => r.category_id)
    )
    const adding = [...new Set(categoryIds)].filter((id) => !heldIds.has(id))
    if (heldIds.size + adding.length > MAX_INTERESTS) {
      return errorResponse(
        `You can pick up to ${MAX_INTERESTS} interests. Remove one to add another.`,
        400,
        "TOO_MANY_INTERESTS"
      )
    }

    /*
     * Existence, and deliberately nothing about which *level* was sent.
     *
     * An earlier draft of Stage 2 wanted this to reject leaves, on the reading
     * that interests were becoming the 13 parents. That reading lost: parents
     * group the picker, leaves are what gets stored, and the ranking expands
     * leaf → parent at read time. So a leaf is the *correct* thing to write and
     * there is no wrong level to reject — only a category that does not exist.
     */
    const existingCategories = await db.categories.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, parent_id: true },
    })

    if (existingCategories.length !== categoryIds.length) {
      return notFoundResponse("One or more categories not found")
    }

    // Add interests (skip duplicates)
    await db.user_interests.createMany({
      data: categoryIds.map((categoryId) => ({
        user_id: userId,
        category_id: categoryId,
      })),
      skipDuplicates: true,
    })

    // Fetch updated interests
    const interests = await db.user_interests.findMany({
      where: { user_id: userId },
      include: {
        category: true,
      },
    })

    return successResponse({
      interests: interests.map((ui) => ({
        id: ui.category.id,
        name: ui.category.name,
        slug: ui.category.slug,
        icon: ui.category.icon,
        addedAt: ui.created_at,
      })),
    })
  } catch (error) {
    logger.error("Add interests error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to add interests")
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { userId } = await params

    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const limited = await rateLimit(request, userLimit("write", "profile-interests", authUser.userId))
    if (limited) return limited

    // Users can only update their own interests
    if (authUser.userId !== userId) {
      return forbiddenResponse("Cannot update another user's interests")
    }

    const body = await readJson(request)

    // Validate input
    const parsed = removeInterestsSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { categoryIds } = parsed.data

    // Remove interests
    await db.user_interests.deleteMany({
      where: {
        user_id: userId,
        category_id: { in: categoryIds },
      },
    })

    // Fetch remaining interests
    const interests = await db.user_interests.findMany({
      where: { user_id: userId },
      include: {
        category: true,
      },
    })

    return successResponse({
      interests: interests.map((ui) => ({
        id: ui.category.id,
        name: ui.category.name,
        slug: ui.category.slug,
        icon: ui.category.icon,
        addedAt: ui.created_at,
      })),
    })
  } catch (error) {
    logger.error("Remove interests error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to remove interests")
  }
}
