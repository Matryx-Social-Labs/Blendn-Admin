import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import type { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { blockCounterparties } from "@/lib/conversations"
import { personCard, personName, personSelect } from "@/lib/friends"
import { friendNameWhere, parseFriendQuery } from "@/lib/friends-here"
import { byName, parseFrom } from "@/lib/friends-by-name"
import { errorResponse, successResponse, unauthorizedResponse, serverErrorResponse } from "@/lib/api-response"
import {
  boundedInt,
  createdBefore,
  keysetPage,
  LEGACY_PAGE,
  LIST_PAGE,
  NEWEST_FIRST,
  parseListQuery,
  type ListPagination,
} from "@/lib/pagination"

/**
 * GET /api/mobile/friends — the caller's friends, newest first, a page at a
 * time, and how many in all.
 *
 * Real names and photos: both people said yes, and this is a friend surface,
 * not a room. A deleted account is dropped rather than shown as a husk.
 *
 * `?q=` (1-40 characters, trimmed) keeps the friends a word of whose name starts
 * with it, case-insensitively: the rule of `GET /events/:id/friends-here`'s `q`
 * (`lib/friends-here.ts`). It combines with `limit` and `cursor`, and
 * `pagination.totalCount` is then the filtered total (`count` too).
 *
 * `?limit=` (default 100, at most 100) and `?cursor=` (the last page's
 * `pagination.nextCursor`). `count` is the whole list, not the page, and
 * `pagination.totalCount` is the same number: an installed client that reads
 * `friends` and `count` shows the first hundred and the true total.
 *
 * `?order=name` (Flow 7 1-A): A–Z instead, under the app's letter rule
 * (`lib/friends-by-name.ts`: Latin A–Z, then each other script's letters, then
 * "#"), with `letters` — every letter head and how many friends file under it,
 * the whole list's, whatever the page. Its own `cursor`, or `?from=<letter>` to
 * start at the first friend filed under that letter or any after it (a scrubber
 * jump); not both. `q` and `limit` work as above, and `letters` follows `q`.
 * `?order=newest` is the default.
 */
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const me = authUser.userId

    // `?q=`: the Room's friend search, over the same name (`friends-here`'s rule), 1-40 characters.
    const q = parseFriendQuery(request.nextUrl.searchParams.get("q"))
    if (q === "too_long") return errorResponse("That search is too long", 400)
    const named = q ? friendNameWhere(q) : {}
    const order = request.nextUrl.searchParams.get("order")
    if (order !== null && order !== "newest" && order !== "name") return errorResponse("Invalid order", 400)

    /*
     * A block severs the friendship under the pair's lock, so this should
     * never filter anything. It is here so that if something ever does
     * leave a row behind, the list still never shows a blocked person — and
     * in the query, not after it, so a page is `limit` friends and the count
     * is the list.
     */
    const blocked = await blockCounterparties(me)
    const mine = {
      OR: [
        { user1_id: me, user2_id: { notIn: blocked }, user2: { deletedAt: null, ...named } },
        { user2_id: me, user1_id: { notIn: blocked }, user1: { deletedAt: null, ...named } },
      ],
    }

    if (order === "name") return await friendsByName(me, mine, request.nextUrl.searchParams)

    const query = parseListQuery(request.nextUrl.searchParams, LIST_PAGE.PEOPLE, LEGACY_PAGE)
    if (query === "bad_cursor") return errorResponse("Invalid cursor", 400)
    const { limit, after } = query

    const [totalCount, rows] = await Promise.all([
      db.friendships.count({ where: mine }),
      db.friendships.findMany({
        where: after ? { AND: [mine, createdBefore(after)] } : mine,
        select: { id: true, created_at: true, user1: { select: personSelect }, user2: { select: personSelect } },
        orderBy: NEWEST_FIRST,
        take: limit + 1,
      }),
    ])
    const page = keysetPage(rows, limit, (r) => ({ at: r.created_at, id: r.id }))

    const friends = page.items.map((r) => ({
      ...personCard(r.user1.id === me ? r.user2 : r.user1),
      since: r.created_at,
    }))

    return successResponse({
      friends,
      count: totalCount,
      pagination: { limit, hasMore: page.hasMore, nextCursor: page.nextCursor, totalCount } satisfies ListPagination,
    })
  } catch (error) {
    logger.error("List friends error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load friends")
  }
}

/**
 * `?order=name`: every friend's id and name in one narrow read, ordered and counted here, then the cards for the page
 * only. ponytail: one row per friend per page read, fine to a few thousand friends (the 12,480 worst case is ~1 MB);
 * past that, a stored sort key on the user and a keyset in SQL.
 */
async function friendsByName(me: string, mine: Prisma.friendshipsWhereInput, params: URLSearchParams) {
  const cursor = params.get("cursor") ?? undefined
  const from = parseFrom(params.get("from"))
  if (from === "bad_from") return errorResponse("Invalid from: one letter or #", 400)
  if (cursor && from) return errorResponse("Use cursor or from, not both", 400)
  const limit = boundedInt(params.get("limit"), LIST_PAGE.PEOPLE, 1, LIST_PAGE.MAX)

  const nameOnly = { id: true, name: true, profile: { select: { name: true } } } as const
  const all = await db.friendships.findMany({
    where: mine,
    select: { created_at: true, user1: { select: nameOnly }, user2: { select: nameOnly } },
  })
  const rows = all.map((r) => {
    const other = r.user1.id === me ? r.user2 : r.user1
    return { userId: other.id, name: personName(other), since: r.created_at }
  })
  const page = byName(rows, { limit, cursor, from })
  if (page === "bad_cursor") return errorResponse("Invalid cursor", 400)

  const cards = await db.user.findMany({ where: { id: { in: page.items.map((r) => r.userId) } }, select: personSelect })
  const byId = new Map(cards.map((c) => [c.id, c]))
  const friends = page.items.flatMap((r) => {
    const card = byId.get(r.userId)
    return card ? [{ ...personCard(card), since: r.since }] : []
  })
  const totalCount = rows.length
  return successResponse({
    friends,
    count: totalCount,
    letters: page.letters,
    pagination: { limit, hasMore: page.hasMore, nextCursor: page.nextCursor, totalCount } satisfies ListPagination,
  })
}
