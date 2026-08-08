import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
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
    const isSelf = authUser.userId === userId

    // Email and phone are only for the profile owner -- everyone else gets
    // the same public-safe shape as /api/mobile/users/[userId].
    //
    // The four preference columns go with them. They are settings, not profile
    // content: whether someone has push on, or shares their location, is a
    // statement about how careful they are being and is nobody else's business.
    // `show_online` governs what others may infer about presence, and the
    // endpoints that honour it read the column directly -- nothing needs it here.
    const {
      phone: _phone,
      push_enabled: _push,
      show_online: _online,
      read_receipts: _receipts,
      share_location: _shareLocation,
      ...publicProfileFields
    } = user.profile ?? {}

    return successResponse({
      id: user.id,
      email: isSelf ? user.email : undefined,
      name: user.name,
      image: user.image,
      createdAt: user.createdAt,
      profile: user.profile
        ? {
            ...(isSelf ? user.profile : publicProfileFields),
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
    logger.error("Get profile error", { error: error instanceof Error ? error.message : String(error) })
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

    const limited = await rateLimit(request, userLimit("write", "profile-update", authUser.userId))
    if (limited) return limited

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

    const {
      name, phone, age, location, bio, occupation, education, interests, photos,
      goals, looking_for, onboarded,
      push_enabled, show_online, read_receipts, share_location,
    } = parsed.data
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
        goals: goals || [],
        looking_for: looking_for || [],
        onboarded: onboarded ?? false,
        // Omitted rather than defaulted: the column defaults to true, which is
        // what the settings screen has always claimed, so nobody's apparent
        // settings change on the day these start being honoured.
        ...(push_enabled !== undefined && { push_enabled }),
        ...(show_online !== undefined && { show_online }),
        ...(read_receipts !== undefined && { read_receipts }),
        ...(share_location !== undefined && { share_location }),
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
        ...(goals !== undefined && { goals }),
        ...(looking_for !== undefined && { looking_for }),
        ...(onboarded !== undefined && { onboarded }),
        ...(push_enabled !== undefined && { push_enabled }),
        ...(show_online !== undefined && { show_online }),
        ...(read_receipts !== undefined && { read_receipts }),
        ...(share_location !== undefined && { share_location }),
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
    logger.error("Update profile error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to update profile")
  }
}
