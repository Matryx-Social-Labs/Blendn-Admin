import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { datingAgeRefusal, stripDating } from "@/lib/age"
import { deriveInterestedIn, type Gender, type Orientation } from "@/lib/dating"
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
      /*
       * Outside the identity gate on purpose — this is the whole reason it
       * exists as a separate column from `occupation`.
       *
       * "Works in design" is an attribute; "Principal Designer at Swiggy" is an
       * address. The coarse bucket is what a pseudonymous room can carry, and
       * the free text below stays behind the gate with the name and the photos.
       */
      work_field: p.work_field,
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
      intent_default, gender, interested_in, work_field, orientation,
      push_enabled, show_online, read_receipts, share_location,
    } = parsed.data
    const normalizedLocation = await normalizeLocationToCity(location)

    /*
     * Dating is 18+, and this is one of the two places it can be written.
     *
     * The age that matters is the age *after* this request: someone sending
     * their age and their intent in one call — which is exactly what the
     * about-you screen does — must not be refused for a null they are in the
     * act of filling in.
     */
    const touchesAgeGate = intent_default !== undefined || age !== undefined
    const touchesDating = gender !== undefined || orientation !== undefined
    const existing =
      touchesAgeGate || touchesDating
        ? await db.profiles.findUnique({
            where: { id: userId },
            select: { age: true, intent_default: true, gender: true, orientation: true },
          })
        : null
    const effectiveAge = age !== undefined ? age : (existing?.age ?? null)

    const refusal = datingAgeRefusal(intent_default, effectiveAge)
    if (refusal) return forbiddenResponse(refusal)

    /*
     * Lowering your age has to take the tag with it.
     *
     * Otherwise the gate is a one-time check at the moment of writing intent,
     * and the way past it is to set 25, tick dating, then set 15 — two requests
     * that are individually legal and leave a 15-year-old in the dating pool.
     * Stripped rather than refused: the age they are giving us is more likely
     * to be the true one, and refusing the correction is the wrong incentive.
     */
    const demotedIntents =
      age !== undefined && intent_default === undefined && existing?.intent_default?.length
        ? stripDating(existing.intent_default, effectiveAge)
        : null
    const stripsDating =
      demotedIntents !== null && demotedIntents.length !== existing?.intent_default.length

    /*
     * `interested_in` is derived from gender and orientation — but only when
     * the request did not supply it.
     *
     * Client-supplied always wins, and that precedence is the load-bearing
     * part. Two writers to one column with no ordering is exactly how someone's
     * hand-picked list gets silently replaced by a derived empty set on the
     * next save that happens to carry an orientation.
     *
     * Derivation returns null for every pair whose meaning is not settled —
     * "straight" plus "non-binary", "queer", "pansexual" — and null here means
     * *leave the column alone and let the app ask*, never "clear it".
     */
    const derivedInterestedIn =
      interested_in === undefined && touchesDating
        ? deriveInterestedIn(
            // The values *after* this request, so changing one of the pair
            // re-derives against the other rather than against nothing.
            (gender !== undefined ? gender : existing?.gender) as Gender | null | undefined,
            (orientation !== undefined ? orientation : existing?.orientation) as
              | Orientation
              | null
              | undefined
          )
        : null

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
        ...(derivedInterestedIn !== null && { interested_in: derivedInterestedIn }),
        ...(orientation !== undefined && { orientation }),
        ...(work_field !== undefined && { work_field }),
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
        // Only when an age change has invalidated a tag they already had.
        ...(stripsDating && { intent_default: demotedIntents! }),
        ...(gender !== undefined && { gender }),
        ...(interested_in !== undefined && { interested_in }),
        // Only when the request did not supply it — client-supplied wins, and
        // a null derivation leaves the column alone rather than clearing it.
        ...(derivedInterestedIn !== null && { interested_in: derivedInterestedIn }),
        ...(orientation !== undefined && { orientation }),
        ...(work_field !== undefined && { work_field }),
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
