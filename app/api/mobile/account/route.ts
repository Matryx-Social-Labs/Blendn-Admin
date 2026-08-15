import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { successResponse, unauthorizedResponse, serverErrorResponse } from "@/lib/api-response"

// DELETE /api/mobile/account — Delete the authenticated user's own account.
//
// We anonymize rather than hard-delete the User row: organized_events,
// chat_messages, and several other relations cascade-delete on User
// removal, which would destroy other users' event history and chat
// history just because one attendee deleted their account. Instead we
// scrub PII, revoke all auth (refresh tokens, push tokens, OAuth links,
// any dashboard sessions), and mark deletedAt so the account can never
// be signed back into.
export async function DELETE(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Authentication required")
    }

    const limited = await rateLimit(request, userLimit("heavy", "account-delete", authUser.userId))
    if (limited) return limited

    const anonymizedEmail = `deleted-${authUser.userId}@deleted.blendn.invalid`

    await db.$transaction([
      db.user.update({
        where: { id: authUser.userId },
        data: {
          name: null,
          email: anonymizedEmail,
          emailVerified: null,
          password: null,
          image: null,
          deletedAt: new Date(),
        },
      }),
      db.profiles.update({
        where: { id: authUser.userId },
        data: {
          name: null,
          phone: null,
          age: null,
          // The most identifying field on the row, so it cannot be the one
          // that survives a deletion: a birth date is a standard security
          // question and half of an identity-theft pair, and it is worth more
          // to whoever gets the database than the age beside it.
          date_of_birth: null,
          location: null,
          bio: null,
          occupation: null,
          education: null,
          interests: [],
          photos: [],
          // Scrubbed like everything else. These were left populated on a
          // deleted account — quietly the most sensitive pair on the profile,
          // since "what are you looking for" is exactly what someone deleting
          // their account would expect to be gone.
          goals: [],
          looking_for: [],
          /*
           * The matching inputs, which are the most sensitive fields on the row.
           *
           * `gender`, `orientations` and `interested_in` are collected only from
           * people who ticked dating, and are returned to nobody but their
           * owner. A deleted account that keeps its owner's sexual orientation
           * is the kind of thing found in an audit rather than in a review —
           * and "delete my account" plainly means this too.
           *
           * `interests` above is the free-text column. The structured rows live
           * in `user_interests` and would cascade if the `User` row were
           * deleted — it deliberately is not, so they are deleted explicitly
           * below.
           */
          gender: null,
          orientations: [],
          // Back to the default, so a deleted-then-restored row cannot come
          // back consenting to something nobody re-consented to.
          show_orientation: false,
          interested_in: [],
          intent_default: [],
          reveal_by_default: false,
          work_field: null,
          onboarded: false,
        },
      }),
      // Structured interests. Nothing cascades here, because the `User` row is
      // deliberately kept — deleting it would cascade other people's chat
      // history and event history along with it.
      db.user_interests.deleteMany({ where: { user_id: authUser.userId } }),
      /*
       * What they were open to, and whether they were named, at each event.
       *
       * `event_check_ins` stays: attendance is somebody else's history too —
       * the organiser's headcount, and the co-presence that lets people who met
       * them still hold a conversation. The *choices* are personal and go.
       */
      db.event_match_preferences.deleteMany({ where: { user_id: authUser.userId } }),
      db.mobile_refresh_tokens.deleteMany({ where: { user_id: authUser.userId } }),
      db.push_tokens.deleteMany({ where: { user_id: authUser.userId } }),
      // The keys carry the user id, and the profile they described has just
      // been scrubbed.
      db.photo_checks.deleteMany({ where: { user_id: authUser.userId } }),
      // Someone who leaves takes their demand signal with them. The row cascades
      // on the foreign key too; this is explicit so the deletion path lists
      // everything it removes rather than relying on a constraint to be read.
      db.city_demand.deleteMany({ where: { user_id: authUser.userId } }),
      db.user_oauth_accounts.deleteMany({ where: { user_id: authUser.userId } }),
      db.account.deleteMany({ where: { userId: authUser.userId } }),
      db.session.deleteMany({ where: { userId: authUser.userId } }),
    ])

    return successResponse({ deleted: true })
  } catch (error) {
    logger.error("Account deletion error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to delete account")
  }
}
