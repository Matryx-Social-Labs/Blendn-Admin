import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { blockedEitherWay } from "@/lib/conversations"
import { maySeeIdentity } from "@/lib/identity"
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

    /*
     * `users/[userId]` checks this with the comment "someone you blocked could
     * keep reading your profile, which is most of what a block is for". This
     * route served a superset of that data and had no such check, so the block
     * was bypassed by changing `/users/` to `/profiles/` in the URL.
     */
    if (!isSelf && (await blockedEitherWay(authUser.userId, userId))) {
      return notFoundResponse("User not found")
    }

    /*
     * An allow-list, because a deny-list ships every column added later.
     *
     * This used to spread the whole `profiles` model and delete five fields,
     * which meant `gender`, `interested_in`, `goals`, `looking_for`,
     * `intent_default` and `reveal_by_default` all went to any authenticated
     * caller for any user id. `schema.prisma` says `gender`/`interested_in` are
     * collected **only** when intent includes dating, so that "less data is
     * held about people who had no reason to give it" -- and then this handed
     * both to strangers. Sexual orientation and stated dating intent for any
     * account on the platform.
     *
     * `users/[userId]` next door already selects explicitly. This now matches.
     */
    /*
     * Same gate as `users/[userId]`. This route serves a superset of that one,
     * so leaving it ungated would have made the other fix decorative.
     */
    const identified = isSelf || (await maySeeIdentity(authUser.userId, userId))

    const p = user.profile
    const publicProfileFields = p && {
      id: p.id,
      age: p.age,
      interests: p.interests,
      onboarded: p.onboarded,
      // Identifying free text, same rule as the name. Someone's employer and
      // their photographs single them out as surely as a name does.
      ...(identified
        ? { bio: p.bio, occupation: p.occupation, education: p.education, photos: p.photos }
        : {}),
    }

    return successResponse({
      id: user.id,
      email: isSelf ? user.email : undefined,
      name: identified ? user.name : "Attendee",
      ...(identified ? { image: user.image } : {}),
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
      intent_default, gender, interested_in,
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
        // Conditional for the same reason as the four switches below: absent
        // must mean "unset", not "cleared". Writing `[]` here would look
        // identical to someone deliberately choosing nothing.
        ...(intent_default !== undefined && { intent_default }),
        ...(gender !== undefined && { gender }),
        ...(interested_in !== undefined && { interested_in }),
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
        ...(intent_default !== undefined && { intent_default }),
        ...(gender !== undefined && { gender }),
        ...(interested_in !== undefined && { interested_in }),
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
