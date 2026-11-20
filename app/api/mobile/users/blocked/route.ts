import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { likeLiteral } from "@/lib/like-literal"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { maySeeIdentityFor } from "@/lib/identity"
import { blockRef } from "@/lib/room-handle"
import { errorResponse, successResponse, unauthorizedResponse, serverErrorResponse } from "@/lib/api-response"
import { createdBefore, keysetPage, LEGACY_PAGE, LIST_PAGE, NEWEST_FIRST, parseListQuery, type ListPagination } from "@/lib/pagination"

/** A search is a name or a place, not a paragraph. */
const SEARCH_MAX = 100
/**
 * At most this many real-name hits are checked against the identity gate per
 * search. ponytail: a name shared by more blocked people than this finds the
 * newest of them only; page the candidates if anybody ever blocks that many.
 */
const NAME_CANDIDATES = 500
/**
 * The newest blocks whose real names a search reads. ponytail: older blocks
 * than this are found by their pseudonym and place only; raise it, or a
 * trigram index on "User".name, if anybody ever blocks more.
 */
const NAME_SCAN = 5000

type Described = { blocked_id: string; blocked: { name: string | null } }

/**
 * GET /api/mobile/users/blocked — the people the caller has blocked, newest
 * first, a page at a time (`?limit=` default 100, at most 100; `?cursor=` the
 * last page's `pagination.nextCursor`) with `pagination.totalCount` the whole
 * list — or, with `?q=`, the whole of what matches. The identity gate and the
 * "known as" lookup below run for the page, not for everybody ever blocked.
 *
 * Each row says what the blocker was shown and where (`seen_as`, `seen_in`,
 * kept on the block by `lib/block-seen.ts`), so two people never named read as
 * two different rows, and whether the account has since been deleted.
 */
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Authentication required")
    }
    const limited = await rateLimit(request, userLimit("read", "blocked-users", authUser.userId))
    if (limited) return limited

    const query = parseListQuery(request.nextUrl.searchParams, LIST_PAGE.PEOPLE, LEGACY_PAGE)
    if (query === "bad_cursor") return errorResponse("Invalid cursor", 400)
    const { limit, after } = query
    const q = request.nextUrl.searchParams.get("q")?.trim() || null
    if (q && q.length > SEARCH_MAX) return errorResponse(`Search is at most ${SEARCH_MAX} characters`, 400)

    const mine = q ? { AND: [{ blocker_id: authUser.userId }, await searchWhere(authUser.userId, q)] } : { blocker_id: authUser.userId }
    const [totalCount, rows] = await Promise.all([
      db.blocked_users.count({ where: mine }),
      db.blocked_users.findMany({
        where: after ? { AND: [mine, createdBefore(after)] } : mine,
        orderBy: NEWEST_FIRST,
        take: limit + 1,
        include: {
          blocked: {
            select: { name: true, deletedAt: true },
          },
        },
      }),
    ])
    const page = keysetPage(rows, limit, (b) => ({ at: b.created_at, id: b.id }))
    const blocks = page.items

    const shown = await describe(authUser.userId, blocks)
    const users = blocks.map((b) => {
      const { name, pseudonym } = shown.get(b.blocked_id) ?? { name: null, pseudonym: null }
      return {
        /*
         * Not their account id: a ref to this block (`blockRef`). Somebody
         * blocked by their board post or room handle was never shown an id,
         * and the list must not be the place it arrives. The unblock route
         * takes this back; the field keeps its name so installed apps, which
         * only send it back, need no change.
         */
        blocked_id: blockRef(b.id),
        blocked_user_name: name,
        // Never a face: the blocked list shows a creature, and a block is the one place a photo should not follow you (SCRUM-834). The key stays for installed builds.
        blocked_user_photo: null,
        reason: null,
        blocked_at: b.created_at.toISOString(),
        // The pseudonym they were shown as (the block's, else a match's), for the creature and the row's name; never a real name.
        seen_as: b.seen_as ?? pseudonym,
        // Where they blocked from: an event's title, a venue day's venue, a room's name. Null when not recorded.
        seen_in: b.seen_in,
        // Deleted since: the row stays, so it can still be unblocked, and says so.
        account_deleted: b.blocked.deletedAt !== null,
      }
    })

    const pagination: ListPagination = { limit, hasMore: page.hasMore, nextCursor: page.nextCursor, totalCount }
    return successResponse({ users, pagination })
  } catch (error) {
    logger.error("Get blocked users error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to fetch blocked users")
  }
}

/**
 * The name each blocked person may be shown by, and the match pseudonym if they
 * had one: one identity gate and one conversation read for the whole list.
 */
async function describe(viewerId: string, blocks: readonly Described[]): Promise<Map<string, { name: string | null; pseudonym: string | null }>> {
  /*
   * Two endpoints, one pair of people, opposite answers.
   *
   * `GET /users/:id` returns 404 for somebody you have blocked. This one
   * returned their real name and their photograph, to the same caller, in the
   * same session -- so blocking somebody was a way to *keep* their identity
   * after the gate that guards it had closed.
   *
   * Worse in one direction than it looks: block is the documented way to undo
   * a reveal. Someone you had revealed to could block you and the list would
   * still hold your face indefinitely.
   *
   * The list still has a job -- you need to see who you have blocked in order
   * to unblock them -- so it keeps whatever it may legitimately show. That is
   * the same `maySeeIdentity` the profile route asks, and for a blocked pair
   * it is false unless the block is one-directional and something else in the
   * rule still holds.
   */
  /*
   * Asked once for the whole list, not once per person.
   *
   * This was `blocks.map((b) => maySeeIdentity(...))`, and the singular gate
   * runs five queries — so a list of twenty blocked people cost a hundred.
   * It reads as correct in review, which is the point: a singular gate on a
   * surface that is always a list invites exactly this, and every surface
   * that resolves identity here is a list.
   */
  const visible = await maySeeIdentityFor(
    viewerId,
    blocks.map((b) => b.blocked_id)
  )

  /*
   * The name you knew them by.
   *
   * With the identity gate closed for every blocked pair, this list rendered
   * "Unknown user" for each row — driven on iOS after blocking from a
   * thread — so someone with three blocks could not tell which was which,
   * and the one job the list has (unblocking) needed a guess. The most
   * recent conversation between the pair knows what the blocker saw: the
   * pseudonym snapshot if it was pseudonymous, the real name if it never was
   * (an accepted request showed it). Neither is new information; it is
   * exactly what the block was a reaction to. No conversation, no name.
   */
  const ids = blocks.map((b) => b.blocked_id)
  const conversations = ids.length
    ? await db.private_conversations.findMany({
        where: {
          OR: [
            { user1_id: viewerId, user2_id: { in: ids } },
            { user2_id: viewerId, user1_id: { in: ids } },
          ],
        },
        orderBy: { created_at: "desc" },
        select: { user1_id: true, user2_id: true, user1_pseudonym: true, user2_pseudonym: true },
      })
    : []
  // `null` in the map means "a conversation that showed the real name".
  const knownAs = new Map<string, string | null>()
  // The match's pseudonym itself, for `seen_as` on a block older than the column.
  const pseudonymOf = new Map<string, string>()
  for (const c of conversations) {
    const theirs = c.user1_id === viewerId ? c.user2_id : c.user1_id
    if (knownAs.has(theirs)) continue // newest first
    const pseudonym = c.user1_id === theirs ? c.user1_pseudonym : c.user2_pseudonym
    const wasPseudonymous = c.user1_pseudonym !== null || c.user2_pseudonym !== null
    // A pseudonymous pair never falls back to a real name, even for a side whose pseudonym is missing.
    knownAs.set(theirs, wasPseudonymous ? (pseudonym ?? "Attendee") : null)
    if (pseudonym) pseudonymOf.set(theirs, pseudonym)
  }
  return new Map(
    blocks.map((b) => [
      b.blocked_id,
      {
        name: visible.has(b.blocked_id) ? b.blocked.name : knownAs.has(b.blocked_id) ? (knownAs.get(b.blocked_id) ?? b.blocked.name) : null,
        pseudonym: pseudonymOf.get(b.blocked_id) ?? null,
      },
    ])
  )
}

/**
 * `?q=`, as a `where` on the caller's blocks: a substring, case-insensitive, of
 * what a row may show — the pseudonym and the place it keeps, a match's
 * pseudonym, or a real name the list would show anyway. A real name is matched
 * in SQL only to find candidates; each is then put through `describe`, so a
 * name the list may not show finds nobody (a search is not a way round the gate).
 */
async function searchWhere(viewerId: string, q: string) {
  const like = { contains: likeLiteral(q), mode: "insensitive" as const }
  const [mine, matches] = await Promise.all([
    db.blocked_users.findMany({ where: { blocker_id: viewerId }, orderBy: NEWEST_FIRST, take: NAME_SCAN, select: { blocked_id: true } }),
    db.private_conversations.findMany({
      where: { OR: [{ user1_id: viewerId, user2_pseudonym: like }, { user2_id: viewerId, user1_pseudonym: like }] },
      orderBy: { created_at: "desc" },
      take: NAME_CANDIDATES,
      select: { user1_id: true, user2_id: true },
    }),
  ])
  // By id, then the name: a join on the name seq-scanned every account for somebody with thousands of blocks.
  const people = await db.user.findMany({
    where: { id: { in: mine.map((b) => b.blocked_id) }, name: like },
    take: NAME_CANDIDATES,
    select: { id: true, name: true },
  })
  const named = people.map((p) => ({ blocked_id: p.id, blocked: { name: p.name } }))
  const shown = await describe(viewerId, named)
  const needle = q.toLocaleLowerCase()
  const ids = [
    ...named.filter((b) => shown.get(b.blocked_id)?.name?.toLocaleLowerCase().includes(needle)).map((b) => b.blocked_id),
    ...matches.map((c) => (c.user1_id === viewerId ? c.user2_id : c.user1_id)),
  ]
  return { OR: [{ seen_as: like }, { seen_in: like }, ...(ids.length ? [{ blocked_id: { in: ids } }] : [])] }
}
