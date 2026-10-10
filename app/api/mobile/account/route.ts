import { logger } from "@/lib/logger"
import { Prisma } from "@prisma/client"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { blockAccountNow } from "@/lib/account-blocklist"
import { evictUserSockets } from "@/lib/socket-server"
import { closeRoomSockets } from "@/lib/room-close"
import { settleCrewsAfterErasure } from "@/lib/crews/sweep"
import { recordDeletedAccount } from "@/lib/deleted-account-records"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { deletePrefix, withdrawFromPublic } from "@/lib/tigris"
import { eraseChatMedia, retainedChatMediaKeys, retainedProfilePhotoKeys } from "@/lib/retained-media"
import { promoteFromWaitlist } from "@/lib/waitlist"
import { performCheckout } from "@/lib/checkout"
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
  // Declared outside the try so the failure log can name the account -- a
  // rolled-back erasure of ~20 tables was logged without saying whose.
  let authUser: Awaited<ReturnType<typeof getAuthenticatedUser>> = null
  try {
    authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Authentication required")
    }

    const limited = await rateLimit(request, userLimit("heavy", "account-delete", authUser.userId))
    if (limited) return limited

    const anonymizedEmail = `deleted-${authUser.userId}@deleted.blendn.invalid`

    /*
     * Where they said they would be, but have not been yet.
     *
     * An RSVP on an event still to come is a promise from a person who no
     * longer exists, and it kept counting: after a deletion the organiser's
     * overview read "1 going · 1 day to go" for nobody, and their pacing was
     * measured against it (SCRUM-132). Past events keep their rows — that is
     * attendance, the organiser's history — but a seat held on a future one is
     * released, and whoever was waiting for it is promoted, as any withdrawal
     * would. Read before the transaction so the promotion can run after it.
     */
    const openRsvps = await db.event_rsvps.findMany({
      // any-kind: erasure releases every seat the person held, whatever the row (PL-I22).
      where: { user_id: authUser.userId, event: { start_time: { gt: new Date() } } },
      select: { event_id: true },
    })
    const openEventIds = [...new Set(openRsvps.map((r) => r.event_id))]

    /*
     * Their board asks somebody reported and nobody has reviewed: the words
     * are the evidence, so the scrub below leaves them until a reviewer has
     * looked (SCRUM-322 review). Read before the transaction, as above.
     */
    const reportedAsks = (
      await db.message_reports.findMany({
        where: {
          message_type: "board_request",
          status: "pending",
          message_id: {
            in: (
              await db.board_requests.findMany({
                where: { from_user_id: authUser.userId },
                select: { id: true },
              })
            ).map((r) => r.id),
          },
        },
        select: { message_id: true },
      })
    ).map((r) => r.message_id)

    /*
     * Their crews: locked, then left, INSIDE the erasure below, and settled
     * after it (D-15: one left dissolves; an owner is handed on). Read inside,
     * not before, so a crew they joined a moment ago is not missed: the
     * DELETE returns exactly the rows it took. The lock comes before the
     * room rows are touched — crew row first, then its room, the order every
     * crew writer takes (lib/crews/sweep.ts).
     */
    const lockCrews = db.$queryRaw<{ id: string }[]>`
      SELECT c.id::text FROM crews c
      WHERE c.dissolved_at IS NULL
        AND c.id IN (SELECT crew_id FROM crew_members WHERE user_id = ${authUser.userId})
      ORDER BY c.id
      FOR UPDATE OF c`
    const leaveCrews = db.$queryRaw<{ crew_id: string }[]>`
      DELETE FROM crew_members WHERE user_id = ${authUser.userId} RETURNING crew_id::text`

    // The rooms of their posts, which close with the erasure below (E1, E3).
    const postRooms = await db.chat_groups.findMany({
      where: { kind: "board_post", board_post: { author_id: authUser.userId } },
      select: { id: true },
    })

    const deletedAt = new Date()
    const erasure = [
      /*
       * FIRST, before anything below scrubs it: the copy of what they
       * registered with that the IT Rules 2021, r.3(1)(h), require for 180
       * days. Inside the batch, so it commits or rolls back with the erasure.
       */
      recordDeletedAccount(authUser.userId, deletedAt),
      db.user.update({
        where: { id: authUser.userId },
        data: {
          name: null,
          email: anonymizedEmail,
          emailVerified: null,
          password: null,
          image: null,
          deletedAt,
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
          /*
           * The blurred derivative goes with the photographs it was made from.
           * It is a picture of the person's face -- 40 pixels of it, but a
           * deleted account should leave no image of them anywhere, and a
           * surviving blur is still a surviving photograph.
           */
          blur_photo: null,
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
          // Three slugs narrow a person further than the bucket above them, so
          // they go for the same reason it does.
          expertise: [],
          // Matching v2 (plan v2 §8): origin-like facts and a sign — exactly
          // what "delete my account" means to be gone.
          languages: [],
          home_state: null,
          sun_sign: null,
          sign_system: null,
          shows_up_badge: false,
          onboarded: false,
        },
      }),
      // Their this-or-that answers: theirs alone, and the profile row they
      // hang off is kept, so nothing cascades.
      db.this_or_that_answers.deleteMany({ where: { user_id: authUser.userId } }),
      // Structured interests. Nothing cascades here, because the `User` row is
      // deliberately kept — deleting it would cascade other people's chat
      // history and event history along with it.
      db.user_interests.deleteMany({ where: { user_id: authUser.userId } }),
      db.event_rsvps.deleteMany({
        where: { user_id: authUser.userId, event_id: { in: openEventIds } },
      }),
      /*
       * What they were open to, and whether they were named, at each event.
       *
       * `event_check_ins` stays: attendance is somebody else's history too —
       * the organiser's headcount, and the co-presence that lets people who met
       * them still hold a conversation. The *choices* are personal and go.
       */
      db.event_match_preferences.deleteMany({ where: { user_id: authUser.userId } }),
      // Their crews' rows locked before any room row below (see `lockCrews`).
      lockCrews,
      /*
       * Out of every room they were in. `left`, not deleted, for the reason
       * the sweeper gives (lib/chat-lifecycle.ts): the pseudonym lives on the
       * row and the transcript resolves through it. Without this they stayed
       * `active` — listed in the room's people and counted in its headcount,
       * under their pseudonym, for ever (SCRUM-193). A ban is a moderation
       * record and outlives the account, as it outlives the room.
       */
      db.chat_group_members.updateMany({
        where: { user_id: authUser.userId, status: { in: ["active", "muted"] } },
        data: { status: "left" },
      }),
      db.mobile_refresh_tokens.deleteMany({ where: { user_id: authUser.userId } }),
      db.push_tokens.deleteMany({ where: { user_id: authUser.userId } }),
      // The keys carry the user id, and the profile they described has just
      // been scrubbed. A pulled photo's verdict stays with its kept object
      // until the purge (docs/RETENTION.md, SCRUM-479).
      db.photo_checks.deleteMany({ where: { user_id: authUser.userId, hidden: false } }),
      // Someone who leaves takes their demand signal with them. The row cascades
      // on the foreign key too; this is explicit so the deletion path lists
      // everything it removes rather than relying on a constraint to be read.
      db.city_demand.deleteMany({ where: { user_id: authUser.userId } }),
      /*
       * Friends, requests either way, and the invite link. Nothing cascades
       * (the `User` row is kept), and a deleted account left on somebody's
       * friends list — or a link that still opened to its husk — would be a
       * person who asked to be erased and was not.
       */
      db.friendships.deleteMany({ where: { OR: [{ user1_id: authUser.userId }, { user2_id: authUser.userId }] } }),
      db.friend_requests.deleteMany({
        where: { OR: [{ sender_id: authUser.userId }, { recipient_id: authUser.userId }] },
      }),
      db.friend_invites.deleteMany({ where: { user_id: authUser.userId } }),
      /*
       * Out of every crew, and every crew invite to them or from them goes —
       * their removal markers too (there is nobody left to keep out), but not
       * the ones they wrote about others (below). Their crew chats'
       * member rows went `left` above with every room's, and their messages
       * stay, as in any room. Each crew is settled after the commit
       * (`settleCrewsAfterErasure`): one left alone dissolves.
       */
      db.crew_invites.deleteMany({
        where: {
          OR: [
            { invited_user_id: authUser.userId },
            // Their open invites go. What they wrote about somebody else stays:
            // a removal marker (the owner's word that a person is out) and a
            // decline (that person's 30 days of quiet) belong to the person
            // they are about, and erasing the owner must not lift either.
            { invited_by: authUser.userId, removed_at: null, declined_at: null },
          ],
        },
      }),
      leaveCrews,
      // Their reveals inside Blends: a name shown to that night's people, theirs to take back now.
      db.blend_reveals.deleteMany({ where: { user_id: authUser.userId } }),
      /*
       * DELETED, not scrubbed, and the consequence is stated because it is
       * visible: every historical "active this week" figure drops by the days
       * this person contributed.
       *
       * A scrubbed row cannot be counted as a distinct person anyway, so
       * nulling `user_id` would keep a row that no longer answers anything
       * while still holding when somebody was awake and looking. Behavioural
       * data about a person, kept after they asked to be erased, in order to
       * make a chart smoother, is not a trade this product should make.
       */
      db.product_events.deleteMany({ where: { user_id: authUser.userId } }),
      db.user_oauth_accounts.deleteMany({ where: { user_id: authUser.userId } }),
      db.account.deleteMany({ where: { userId: authUser.userId } }),
      db.session.deleteMany({ where: { userId: authUser.userId } }),

      /*
       * WHERE THEY STOOD, on the rows that deliberately stay.
       *
       * `event_check_ins` is kept because attendance is somebody else's history
       * too — the organiser's headcount, and the co-presence that lets people
       * who met them still hold a conversation. But the row also carries the
       * GPS fix that validated the check-in and a device fingerprint, and
       * neither is needed by any of those readers. A headcount needs a count.
       *
       * So the fact stays and the coordinates go. This is the gap that made the
       * rest of this transaction misleading: it scrubbed nineteen profile
       * fields and left a trail of exactly where somebody was, on which nights,
       * to within a few metres.
       */
      db.event_check_ins.updateMany({
        where: { user_id: authUser.userId },
        data: { latitude: null, longitude: null, device_info: Prisma.DbNull },
      }),

      /*
       * The same, for presence sessions — and this one was introduced by the
       * presence work itself. `last_lat`, `last_lng` and `last_accuracy` are a
       * position, on a table added after this transaction was last reviewed,
       * so the deletion path silently stopped being complete the day the model
       * landed. Sessions stay for the same reason check-ins do: dwell and
       * occupancy are the organiser's numbers, not the attendee's.
       */
      db.presence_sessions.updateMany({
        where: { user_id: authUser.userId },
        data: { last_lat: null, last_lng: null, last_accuracy: null },
      }),

      /*
       * Every notification they were ever sent.
       *
       * `title` and `body` are a permanent copy of push previews — counterparty
       * names and message text — sitting outside every access control that
       * guards the messages themselves. Deleted rather than redacted: these are
       * this person's own notifications, nobody else reads them, and a redacted
       * shell of a notification serves no one.
       */
      db.notifications.deleteMany({ where: { user_id: authUser.userId } }),

      // A live reset token for an account that no longer exists is a way back
      // into it. Cascades on the FK too; listed so this path enumerates what it
      // removes rather than trusting a constraint to be read.
      db.password_reset_tokens.deleteMany({ where: { user_id: authUser.userId } }),

      /*
       * What they wrote to strangers, and only what THEY wrote.
       *
       * The request row is a two-party artifact and stays — the recipient's
       * inbox should not develop holes. The `message` is one party's words, so
       * only the ones they SENT are scrubbed. Requests they received are
       * somebody else's sentence and are not theirs to erase.
       */
      db.message_requests.updateMany({
        where: { sender_id: authUser.userId },
        data: { message: null },
      }),

      /*
       * Their board posts go, and the requests against them go with them.
       *
       * An offer of a spare seat whose author has deleted their account cannot
       * be accepted — the entire point of answering it is to meet that person.
       * Keeping it would leave an offer nobody can take, and a `seeking` post
       * asking for help that can no longer be given.
       *
       * The cascade on `post_id` takes other people's requests to those posts
       * with it, and that is right rather than merely unavoidable: a request to
       * a post that no longer exists is not a request, it is a dangling
       * sentence.
       *
       * EXCEPT a post moderation took down. That row is the removed content
       * and the only record of its removal, and the IT Rules 2021, r.3(1)(g),
       * require both for 180 days — an author deleting their account must not
       * be the way to destroy the evidence. It is already hidden, so nobody
       * is left holding an offer they cannot take.
       */
      db.board_posts.deleteMany({ where: { author_id: authUser.userId, moderation_status: null, room: { is: null } } }),

      /*
       * EXCEPT a post with a room (step 7, E1). The room is other people's
       * conversation — the accepted askers' messages, anything moderation hid
       * or somebody reported, which the IT Rules keep for 180 days — and a
       * room cannot outlive its post (`board_post_id` is ON DELETE RESTRICT).
       * So the post stays as a row: off the board (`deleted_at`, which also
       * closes the room's door), its words erased like an ask's, and its room
       * archived with every message and member kept.
       */
      db.chat_groups.updateMany({
        where: { kind: "board_post", board_post: { author_id: authUser.userId }, status: { not: "archived" } },
        data: { status: "archived" },
      }),
      db.board_posts.updateMany({
        where: { author_id: authUser.userId, moderation_status: null, room: { isNot: null }, deleted_at: null },
        data: { deleted_at: deletedAt },
      }),
      db.board_posts.updateMany({
        where: { author_id: authUser.userId, moderation_status: null, room: { isNot: null } },
        data: { body: "" },
      }),

      /*
       * And a post somebody REPORTED, still waiting for a reviewer. Filing the
       * report stamps it `moderation_status = "reported"` (lib/board-access.ts,
       * `fileBoardReport`), so the delete above leaves it — the post is the
       * evidence, and an author deleting their account must not be how a
       * report loses it. It comes off the board here, as the author does.
       */
      db.board_posts.updateMany({
        where: { author_id: authUser.userId, moderation_status: "reported", deleted_at: null },
        data: { deleted_at: new Date() },
      }),

      /*
       * Requests they SENT to other people's posts: the row survives — the
       * recipient's board should not develop holes — and only their words go.
       * The same rule as `message_requests`, for the same reason: a request
       * they received is somebody else's sentence.
       */
      db.board_requests.updateMany({
        // Except an ask somebody reported that nobody has reviewed yet: its
        // words are the evidence. The report also keeps a copy (`excerpt`).
        where: { from_user_id: authUser.userId, id: { notIn: reportedAsks } },
        data: { message: null },
      }),

      /*
       * Their conversations close. Driven after a deletion: the other person's
       * inbox still listed the thread under the pseudonym, a message into it
       * returned 200 and wrote a notification row for the erased account, and
       * nothing told the sender they were talking to nobody. Closed is "gone
       * for both people" everywhere else in the product, so it is the right
       * state here too; the messages stay for moderation, as they do on a
       * block.
       */
      db.private_conversations.updateMany({
        where: {
          OR: [{ user1_id: authUser.userId }, { user2_id: authUser.userId }],
          closed_at: null,
        },
        data: { closed_at: new Date(), closed_by: authUser.userId, closed_reason: "account_deleted" },
      }),

      /*
       * Their name in other people's notification centres.
       *
       * A DM push is titled with the sender's name — the real one after a
       * reveal — and a message-request push names them in the body. Those
       * rows belong to the other person and survive this deletion, so the
       * name kept appearing in a list two hours after the account was gone.
       * Driven: "Dev Tester — Sent you a message" in the recipient's centre
       * after Dev Tester had erased everything. Redacted to a neutral word;
       * the row's job (a deep link into a now-closed thread) is done anyway.
       */
      db.$executeRaw`
        UPDATE notifications
        SET title = 'Someone'
        WHERE kind = 'private_message'
          AND data->>'conversationId' IN (
            SELECT id::text FROM private_conversations
            WHERE user1_id = ${authUser.userId} OR user2_id = ${authUser.userId}
          )`,
      db.$executeRaw`
        UPDATE notifications
        SET body = 'Someone wants to connect'
        WHERE kind = 'message_request'
          AND data->>'requestId' IN (
            SELECT id::text FROM message_requests WHERE sender_id = ${authUser.userId}
          )`,
      db.$executeRaw`
        UPDATE notifications
        SET body = 'Someone accepted your message request'
        WHERE kind = 'message_request_response'
          AND data->>'requestId' IN (
            SELECT id::text FROM message_requests WHERE recipient_id = ${authUser.userId}
          )`,
    ]
    const erased = await db.$transaction(erasure)

    /*
     * After the transaction, not inside it: storage is not transactional and
     * a listing failure must not roll back an erasure the database already
     * accepted. Failure here is logged with the id, and the objects stay
     * reachable until a retry -- which is the state everything was in
     * before, now visible rather than silent.
     */
    // The token that made this request is dead from here: without this, it
    // could put a name back on the profile just erased (SCRUM-132).
    blockAccountNow(authUser.userId)
    // And so is every socket it already had open. The handshake gate refuses
    // a new one, but a second phone's live connection kept its rooms and DMs
    // coming after the erasure (SCRUM-449). Suspension does the same.
    evictUserSockets(authUser.userId)
    // Their posts' rooms are archived and their door now says hidden; whoever
    // was still in one is taken out, as from a post withdrawn (E3).
    for (const room of postRooms) closeRoomSockets(room.id)
    // A crew they leave with one person in it dissolves; an owner is handed
    // on. Never throws; a crew it misses, the chat sweeper repairs.
    const leftCrews = erased[erasure.indexOf(leaveCrews)] as { crew_id: string }[]
    await settleCrewsAfterErasure(leftCrews.map((row) => row.crew_id))

    // Seats they held are free now; the waitlist moves, per event.
    for (const eventId of openEventIds) {
      await promoteFromWaitlist(eventId).catch((error) =>
        logger.warn("Account deletion: waitlist promotion failed", {
          eventId,
          error: error instanceof Error ? error.message : String(error),
        })
      )
    }

    /*
     * Out of every room they were standing in. The check-in stays, as above,
     * but an open one kept an erased person "here now": in the live headcount,
     * and offered under Meet next until the event ended (SCRUM-481).
     * `performCheckout` is the one path that ends a check-in and its presence
     * session together.
     */
    try {
      const standing = await db.event_check_ins.findMany({
        where: { user_id: authUser.userId, status: "checked_in" },
        select: { id: true },
      })
      for (const { id } of standing) {
        await performCheckout(id, "manual", deletedAt).catch((error) =>
          logger.warn("Account deletion: checkout failed", {
            checkInId: id,
            error: error instanceof Error ? error.message : String(error),
          })
        )
      }
    } catch (error) {
      // Never at the cost of the storage erasure below. The account is already
      // gone and a retry is a 401, so a 500 here would keep the uploads for ever.
      logger.warn("Account deletion: open check-ins not read", {
        userId: authUser.userId,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    /*
     * Everything the person could upload from the app: profile photos and the
     * images they sent in DMs and rooms. Only profile/ was listed, so a deleted
     * account's chat images stayed in the public bucket, reachable forever
     * (SCRUM-428). events/, sponsored/ and claims/ hold an organisation's
     * records, not this person's media. One folder failing does not skip the
     * next.
     *
     * Except removed content: an image in a message moderation hid, flagged or
     * someone reported, and a profile photo moderation pulled, stay for their
     * 180 days (docs/RETENTION.md, r.3(1)(g)).
     */
    for (const folder of ["profile", "chat"] as const) {
      try {
        let gone: number
        if (folder === "chat") {
          // The uploads and older copies by prefix; copies sealed since SCRUM-448 through the messages.
          gone = await eraseChatMedia(authUser.userId, await retainedChatMediaKeys(authUser.userId))
        } else {
          const kept = await retainedProfilePhotoKeys(authUser.userId)
          // Off the public bucket first: `keep` spares a key in both buckets,
          // and this retries a withdrawal that failed when the photo was pulled.
          for (const key of kept) await withdrawFromPublic(key)
          gone = await deletePrefix(`profile/${authUser.userId}/`, kept)
        }
        logger.info("Account deletion: uploads removed from storage", { userId: authUser.userId, folder, gone })
      } catch (error) {
        logger.error("Account deletion: uploads NOT removed from storage", {
          userId: authUser.userId,
          folder,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return successResponse({ deleted: true })
  } catch (error) {
    logger.error("Account deletion error", { userId: authUser?.userId, error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to delete account")
  }
}
