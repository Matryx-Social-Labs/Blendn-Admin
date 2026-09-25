// Relative imports throughout — see lib/conversations.ts. Enforced by
// __tests__/server-import-boundary.test.ts.
import { ageFrom } from "./age"
import { preferredPseudonymFor } from "./anonymous-names"
import {
  mayPostToBoard,
  type BoardEntitlement,
  type BoardWriteDenial,
} from "./board"
import { BOARD } from "./constants"
import { db } from "./db"
import { checkContactInfo } from "./moderation/contact-info"
import { checkKeywords } from "./moderation/keyword-filter"
import { checkTextContent, notChecked, type ModerationCheck } from "./moderation/openai-moderation"

/**
 * The database half of the board's gates.
 *
 * `lib/board.ts` is the rules and is pure. This is what the rules need to be
 * asked, and it lives here rather than in a route because four routes ask the
 * same three questions — the board, the request send, the request list and the
 * decision — and four copies of a gate is how the same gate ends up with four
 * answers. That is the finding this whole audit is about; the board is new
 * enough to not have it yet.
 */

/**
 * A request that is still worth answering.
 *
 * `pending` is not that on its own. A request is an ask about one event, and
 * once the event has ended — or the post it answers has been taken down —
 * there is nothing left to answer. The row stays `pending` for ever anyway,
 * because the only writers of `status` are a human deciding and account
 * deletion: nothing closes a request when its event ends.
 *
 * That matters because of the cap. Counting bare `pending` meant five
 * unanswered asks about events from last year permanently stopped somebody
 * asking again — the cap bounds a spray, and instead it bounded a lifetime.
 *
 * So liveness is **derived, not swept**: the same reason "inside now" is a
 * query and never a counter. There is no job to forget to run, no new enum
 * value, and no status to drift out of agreement with the event.
 *
 * A function rather than a constant: a module-level `new Date()` freezes at
 * import, so the answer would be wrong by however long the process has been up
 * — which on a long-lived server is the whole bug again, quieter.
 */
export function liveRequest(now: Date = new Date()): {
  status: "pending"
  event: { end_time: { gt: Date } }
  post: { deleted_at: null }
} {
  return {
    status: "pending",
    event: { end_time: { gt: now } },
    post: { deleted_at: null },
  }
}

/**
 * The same rule as `liveRequest()`, applied to a row already read.
 *
 * Two forms of one rule is a thing this codebase is right to be suspicious of.
 * They are adjacent and pinned against each other by a test that runs both over
 * the same fixtures, because the alternative — a second query per rendered row,
 * or the list route inlining `end_time > now` itself — is the drift this module
 * exists to prevent.
 */
export function isLiveRequest(
  request: {
    status: string
    event: { end_time: Date }
    post: { deleted_at: Date | null }
  },
  now: Date = new Date()
): boolean {
  return (
    request.status === "pending" &&
    request.event.end_time > now &&
    request.post.deleted_at === null
  )
}

/** What the viewer has done about this event. Both gates read it. */
export async function entitlementFor(
  eventId: string,
  userId: string
): Promise<BoardEntitlement> {
  const [rsvp, favourite] = await Promise.all([
    db.event_rsvps.findFirst({
      where: { event_id: eventId, user_id: userId },
      select: { status: true },
    }),
    db.event_favorites.findFirst({
      where: { event_id: eventId, user_id: userId },
      select: { id: true },
    }),
  ])
  return {
    rsvp: (rsvp?.status as BoardEntitlement["rsvp"]) ?? null,
    favourited: favourite !== null,
  }
}

/**
 * May they put something on this board — a post, or a request?
 *
 * One function for both, deliberately. Posting an offer and asking somebody
 * for a seat are the same commitment from the board's point of view: you are
 * going, we know enough about you to describe you, and you are not spraying.
 * Splitting them would invite the caps to be applied to one and not the other,
 * which is how a cap gets defeated.
 */
export async function boardWriteDenial(
  eventId: string,
  userId: string
): Promise<BoardWriteDenial | null> {
  const [entitlement, profile, interests, outstanding, thisWeek] = await Promise.all([
    entitlementFor(eventId, userId),
    db.profiles.findUnique({
      where: { id: userId },
      select: { name: true, age: true, date_of_birth: true, intent_default: true },
    }),
    db.user_interests.count({ where: { user_id: userId } }),
    db.board_requests.count({ where: { from_user_id: userId, ...liveRequest() } }),
    db.board_requests.count({
      where: {
        from_user_id: userId,
        created_at: {
          gte: new Date(Date.now() - BOARD.REQUEST_WEEK_DAYS * 24 * 60 * 60 * 1000),
        },
      },
    }),
  ])

  return mayPostToBoard(
    entitlement,
    {
      name: profile?.name ?? null,
      // Derived, never the stored column — see lib/age.ts.
      age: ageFrom(profile ?? null),
      interestCount: interests,
      intentCount: profile?.intent_default?.length ?? 0,
    },
    { outstandingRequests: outstanding, requestsThisWeek: thisWeek }
  )
}

/**
 * Everyone's handle at this event, for the ids asked about.
 *
 * The room's `anonymous_name` where one exists, and `preferredPseudonymFor`
 * where it does not — which before doors is everybody, because the room handle
 * is minted at check-in and the board is what happens before check-in.
 *
 * **It previously fell back to the literal string "Attendee".** That was
 * written for the room, where a missing handle is a bug and degrading to the
 * real name would turn that bug into a disclosure. On the board it is not a
 * bug, it is the ordinary state, so every post before doors rendered as
 * "Attendee" — a wall of one name, on the surface whose entire job is letting
 * people tell each other apart well enough to agree to travel together.
 *
 * Check-in prefers the same handle when it is free, so the name someone
 * answered on the board is the name they carry into the room.
 */
export async function boardPseudonyms(
  eventId: string,
  userIds: readonly string[]
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)]
  if (ids.length === 0) return new Map()

  const members = await db.chat_group_members.findMany({
    where: { chat_group: { event_id: eventId }, user_id: { in: ids } },
    select: { user_id: true, anonymous_name: true },
  })
  const roomName = new Map(
    members
      .filter((m) => m.anonymous_name)
      .map((m) => [m.user_id, m.anonymous_name as string])
  )

  return new Map(ids.map((id) => [id, roomName.get(id) ?? preferredPseudonymFor(eventId, id)]))
}

/** What refused board text is told. One sentence for every non-contact refusal, so it teaches nothing about the filter. */
export const BOARD_REFUSAL = "This can't go on the board."

export interface BoardTextVerdict {
  /** The sentence to refuse with, or null to let it through. */
  refusal: string | null
  /** OpenAI was asked and did not answer in time (or erred), so the pass is provisional. */
  unchecked: boolean
}

/**
 * Whether this text may go on the board, and how sure we are (SCRUM-301).
 *
 * The same checks a room message gets before anyone else can see it: the
 * keyword filter, contact details, then OpenAI within the room's one-second
 * bound. The room stores a hit hidden and counts it toward a mute; the board
 * has no moderation queue, so a hit is refused and never stored. Contact
 * details say which — the fix is the poster's to make.
 *
 * A timeout passes, as in the room, but provisionally: `unchecked` tells the
 * caller to look again without the bound (`hideBoardPostIfFlagged`), which is
 * what the room's `moderateMessage` does after it stores. No key is not
 * `unchecked` — a second look would not have one either.
 */
export async function checkBoardText(text: string): Promise<BoardTextVerdict> {
  if (checkKeywords(text)?.action === "hide") return { refusal: BOARD_REFUSAL, unchecked: false }
  const contact = checkContactInfo(text)
  if (contact) {
    return {
      refusal: `${contact.reason} The board is anonymous, so contact details can't go on it.`,
      unchecked: false,
    }
  }

  let timeout: ReturnType<typeof setTimeout> | undefined
  const check = await Promise.race([
    checkTextContent(text),
    new Promise<ModerationCheck>((resolve) => {
      timeout = setTimeout(() => resolve(notChecked("timeout")), 1000)
    }),
  ]).finally(() => clearTimeout(timeout))
  if (check.checked) {
    return { refusal: check.result?.action === "hide" ? BOARD_REFUSAL : null, unchecked: false }
  }
  return { refusal: null, unchecked: check.reason !== "no_key" }
}

/**
 * The second look for a post whose first one ran out of time: OpenAI without
 * the bound, and down it comes if it would have been refused. Marked
 * `moderation_status = "hidden"` so it reads differently from a withdrawal.
 */
export async function hideBoardPostIfFlagged(postId: string, body: string): Promise<void> {
  const check = await checkTextContent(body)
  if (!check.checked || check.result?.action !== "hide") return
  // Only a post still up: one its author withdrew meanwhile keeps its own
  // timestamp and reads as a withdrawal, not as something we caught.
  await db.board_posts.updateMany({
    where: { id: postId, deleted_at: null },
    data: { deleted_at: new Date(), moderation_status: "hidden", updated_at: new Date() },
  })
}
