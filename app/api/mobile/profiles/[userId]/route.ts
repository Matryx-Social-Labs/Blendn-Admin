import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { checkProfilePhoto } from "@/lib/photos"
import { recordPhotoCheck } from "@/lib/photo-checks"
import { ageFrom, datingAgeRefusal, parseDateOfBirth, stripDating } from "@/lib/age"
import { deriveInterestedIn, type Gender, type Orientation } from "@/lib/dating"
import { blockedEitherWay } from "@/lib/conversations"
import { maySeeIdentity } from "@/lib/identity"
import { profileForSelfResponse } from "@/lib/self-profile"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  errorResponse,
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
    // Derived, so the number is true today rather than on the day they signed
    // up. See `ageFrom` in lib/age.ts — this is a read of the derived value,
    // never of `date_of_birth`, which is stripped from both branches below.
    const profileAge = ageFrom(p)
    const publicProfileFields = p && {
      id: p.id,
      age: profileAge,
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
      /*
       * Orientation, and only when *both* are true: they turned it on, and you
       * are someone who can already see who they are.
       *
       * Two gates rather than one because they answer different questions.
       * `show_orientation` is consent to show it at all — special-category data
       * under GDPR Article 9, so silence is not consent and the column defaults
       * false. `identified` is who to. A switch alone would publish it to any
       * caller holding a token, which is a wider audience than the person's own
       * name and photograph get, and that ordering is backwards.
       *
       * `gender` and `interested_in` stay withheld from everyone regardless.
       * They are matching inputs; the compatibility they compute surfaces as a
       * tag on a card, never as the values behind it.
       */
      ...(identified && p.show_orientation ? { orientation: p.orientation } : {}),
    }

    /*
     * Everything the owner may see about themselves: the whole row minus the
     * birth date, plus the derived age in place of the stored one.
     *
     * Destructured rather than re-listed so a new column reaches its owner
     * without a code change — the withholding is the deliberate part, and it
     * is one name long.
     */
    const { date_of_birth: _dob, ...selfProfileFields } = { ...p, age: profileAge }

    return successResponse({
      id: user.id,
      email: isSelf ? user.email : undefined,
      name: identified ? user.name : "Attendee",
      ...(identified ? { image: user.image } : {}),
      createdAt: user.createdAt,
      profile: user.profile
        ? {
            /*
             * `selfProfileFields` rather than `user.profile`: the spread is a
             * deny-list, which is the exact pattern the comment above rejects
             * for the public branch. `date_of_birth` is the column that made
             * that concrete — added for the age gate, it would have started
             * appearing in this response the moment it was written, purely
             * because nothing here names its fields.
             *
             * Self still gets everything else, including the free text and the
             * dating fields the public branch withholds.
             */
            ...(isSelf ? selfProfileFields : publicProfileFields),
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
      name, phone, age, dateOfBirth, location, bio, occupation, education, interests, photos,
      goals, looking_for, onboarded, reveal_by_default,
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
    /*
     * Validated in the schema, so a non-null string here always parses. Done
     * once because it is needed three times below: the gate, the demotion, and
     * the write.
     */
    const parsedDob = dateOfBirth !== undefined ? parseDateOfBirth(dateOfBirth) : null

    const touchesAgeGate =
      intent_default !== undefined || age !== undefined || dateOfBirth !== undefined
    const touchesDating = gender !== undefined || orientation !== undefined
    // `photos` joins the reasons to fetch: the moderation pass below only
    // checks URLs that are not already on the profile, so re-saving a profile
    // does not re-fetch and re-moderate the same three photos every time.
    const existing =
      touchesAgeGate || touchesDating || photos !== undefined
        ? await db.profiles.findUnique({
            where: { id: userId },
            select: {
              age: true,
              date_of_birth: true,
              intent_default: true,
              gender: true,
              orientation: true,
              photos: true,
            },
          })
        : null
    /*
     * The profile as it will be *after* this request, handed to `ageFrom` so
     * the gate applies the same precedence the read paths do — birth date over
     * stored number, whichever of the two this request happens to carry.
     *
     * Written as one source object rather than a chain of ternaries because
     * the precedence is the part that has to match `ageFrom` exactly: a gate
     * that reads the sent `age` while every reader derives from an existing
     * `date_of_birth` is a gate on a number nothing else believes.
     */
    const effectiveAge = ageFrom({
      date_of_birth: parsedDob ?? existing?.date_of_birth ?? null,
      age: age !== undefined ? age : (existing?.age ?? null),
    })

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
      (age !== undefined || dateOfBirth !== undefined) &&
      intent_default === undefined &&
      existing?.intent_default?.length
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

    /*
     * Every new photo is checked before it is stored.
     *
     * Nothing had ever checked a profile photo. `checkImageContent` was wired
     * to chat media and never to profiles, so the one image a stranger sees on
     * a match card was the one image nobody screened.
     *
     * Only URLs that are not already on the profile are checked: re-saving a
     * profile is the commonest write there is, and it must not re-fetch and
     * re-moderate the same three photos every time. Concurrently, not in
     * series -- six photos is one round trip, not six.
     */
    if (photos !== undefined && photos.length > 0) {
      const alreadyOnProfile = new Set(existing?.photos ?? [])
      const fresh = photos.filter((u: string) => !alreadyOnProfile.has(u))

      if (fresh.length > 0) {
        const verdicts = await Promise.all(
          fresh.map((u: string) => checkProfilePhoto(u, userId))
        )
        const bad = verdicts.find((v) => !v.ok)
        if (bad && !bad.ok) {
          return errorResponse(bad.message, 400, bad.code)
        }

        await Promise.all(
          fresh.map((u: string, i: number) =>
            recordPhotoCheck(u, userId, verdicts[i].ok && verdicts[i].checked)
          )
        )
      }
    }

    // Update user record (name and/or primary photo)
    const userUpdate: Record<string, unknown> = {}
    if (name !== undefined) userUpdate.name = name
    /*
     * `User.image` is a MIRROR of the chosen primary photo, not a second
     * opinion about it.
     *
     * Two columns held a face and the surfaces disagreed: the match card read
     * `photos[0] ?? user.image`, conversations read `user.image` alone. A
     * Google avatar therefore counted as a face in some places and not others,
     * and it had never been through moderation anywhere.
     *
     * The clearing half is the part that was missing. This only ever SET the
     * column, so deleting every photo left the old image rendering on DM
     * avatars forever.
     */
    if (photos !== undefined) userUpdate.image = photos[0] ?? null
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
        // The derived number when a date came with the request, so the stored
        // column stays a usable fallback and the dashboard keeps reading true.
        age: parsedDob ? effectiveAge : age,
        ...(parsedDob && { date_of_birth: parsedDob }),
        location: normalizedLocation,
        bio,
        occupation,
        education,
        interests: interests || [],
        photos: photos || [],
        goals: goals || [],
        looking_for: looking_for || [],
        onboarded: onboarded ?? false,
        ...(reveal_by_default !== undefined && { reveal_by_default }),
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
        // Same reasoning as the create branch: a date written here also
        // refreshes the number beside it, so the two never disagree on the day
        // they are set.
        ...(parsedDob && { date_of_birth: parsedDob, age: effectiveAge }),
        ...(location !== undefined && { location: normalizedLocation }),
        ...(bio !== undefined && { bio }),
        ...(occupation !== undefined && { occupation }),
        ...(education !== undefined && { education }),
        ...(interests !== undefined && { interests }),
        ...(photos !== undefined && { photos }),
        ...(goals !== undefined && { goals }),
        ...(looking_for !== undefined && { looking_for }),
        ...(onboarded !== undefined && { onboarded }),
        // A suggestion the room re-asks by way of a tap — check-in still
        // creates the row with `revealed: false` whatever this says.
        ...(reveal_by_default !== undefined && { reveal_by_default }),
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
      /*
       * Shaped, not raw. This is the eighth place the whole `profiles` row was
       * being spread into a response, and the only one neither #220 nor #221
       * found — because both were looking at read paths, and this is the
       * *write* path returning what it just wrote.
       *
       * It was caught by making a real PUT to staging and reading the body.
       */
      profile: profileForSelfResponse(user!.profile),
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
