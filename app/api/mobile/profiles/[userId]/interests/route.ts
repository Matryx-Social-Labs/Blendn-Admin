import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import {
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { addInterestsSchema, removeInterestsSchema } from "@/lib/validations/profile"

interface RouteParams {
  params: Promise<{ userId: string }>
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { userId } = await params

    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    // Fetch user interests
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

    // Users can only update their own interests
    if (authUser.userId !== userId) {
      return forbiddenResponse("Cannot update another user's interests")
    }

    const body = await request.json()

    // Validate input
    const parsed = addInterestsSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { categoryIds } = parsed.data

    // Verify all categories exist
    const existingCategories = await db.categories.findMany({
      where: { id: { in: categoryIds } },
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

    // Users can only update their own interests
    if (authUser.userId !== userId) {
      return forbiddenResponse("Cannot update another user's interests")
    }

    const body = await request.json()

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
