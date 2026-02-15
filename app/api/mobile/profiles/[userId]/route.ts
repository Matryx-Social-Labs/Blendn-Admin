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
import { normalizeLocationToCity } from "@/lib/location"

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

    const normalizedLocation = await normalizeLocationToCity(user.profile?.location)

    return successResponse({
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      createdAt: user.createdAt,
      profile: user.profile
        ? {
            ...user.profile,
            location: normalizedLocation,
          }
        : null,
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

    const { name, phone, age, location, bio, occupation, education, interests, photos, onboarded } = parsed.data
    const normalizedLocation = await normalizeLocationToCity(location)

    // Update user record (name and/or primary photo)
    const userUpdate: Record<string, unknown> = {}
    if (name !== undefined) userUpdate.name = name
    if (photos !== undefined && photos.length > 0) userUpdate.image = photos[0]
    if (Object.keys(userUpdate).length > 0) {
      await db.user.update({
        where: { id: userId },
        data: userUpdate,
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
        location: normalizedLocation,
        bio,
        occupation,
        education,
        interests: interests || [],
        photos: photos || [],
        onboarded: onboarded ?? false,
      },
      update: {
        ...(name !== undefined && { name }),
        ...(phone !== undefined && { phone }),
        ...(age !== undefined && { age }),
        ...(location !== undefined && { location: normalizedLocation }),
        ...(bio !== undefined && { bio }),
        ...(occupation !== undefined && { occupation }),
        ...(education !== undefined && { education }),
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
