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
import { updateProfileSchema } from "@/lib/validations/profile"

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

    // Fetch user with profile
    const user = await db.user.findUnique({
      where: { id: userId },
      include: {
        profile: true,
        user_interests: {
          include: {
            category: true,
          },
        },
      },
    })

    if (!user) {
      return notFoundResponse("User not found")
    }

    return successResponse({
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      createdAt: user.createdAt,
      profile: user.profile,
      interests: user.user_interests.map((ui) => ({
        id: ui.category.id,
        name: ui.category.name,
        slug: ui.category.slug,
        icon: ui.category.icon,
      })),
    })
  } catch (error) {
    console.error("Get profile error:", error)
    return serverErrorResponse("Failed to get profile")
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { userId } = await params

    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    // Users can only update their own profile
    if (authUser.userId !== userId) {
      return forbiddenResponse("Cannot update another user's profile")
    }

    const body = await request.json()

    // Validate input
    const parsed = updateProfileSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { name, phone, age, location, interests, photos, onboarded } = parsed.data

    // Update user name if provided
    if (name !== undefined) {
      await db.user.update({
        where: { id: userId },
        data: { name },
      })
    }

    // Update or create profile
    await db.profiles.upsert({
      where: { id: userId },
      create: {
        id: userId,
        name,
        phone,
        age,
        location,
        interests: interests || [],
        photos: photos || [],
        onboarded: onboarded ?? false,
      },
      update: {
        ...(name !== undefined && { name }),
        ...(phone !== undefined && { phone }),
        ...(age !== undefined && { age }),
        ...(location !== undefined && { location }),
        ...(interests !== undefined && { interests }),
        ...(photos !== undefined && { photos }),
        ...(onboarded !== undefined && { onboarded }),
        updated_at: new Date(),
      },
    })

    // Fetch updated user with profile
    const user = await db.user.findUnique({
      where: { id: userId },
      include: {
        profile: true,
        user_interests: {
          include: {
            category: true,
          },
        },
      },
    })

    return successResponse({
      id: user!.id,
      email: user!.email,
      name: user!.name,
      image: user!.image,
      profile: user!.profile,
      interests: user!.user_interests.map((ui) => ({
        id: ui.category.id,
        name: ui.category.name,
        slug: ui.category.slug,
        icon: ui.category.icon,
      })),
    })
  } catch (error) {
    console.error("Update profile error:", error)
    return serverErrorResponse("Failed to update profile")
  }
}
