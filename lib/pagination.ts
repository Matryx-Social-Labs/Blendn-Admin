import { PAGINATION } from "@/lib/constants"

export interface PaginationParams {
  page: number
  limit: number
}

export interface PaginationMeta {
  page: number
  limit: number
  totalCount: number
  totalPages: number
  hasMore: boolean
}

export interface CursorPaginationParams {
  cursor?: string
  limit: number
}

export interface CursorPaginationMeta {
  limit: number
  hasMore: boolean
  nextCursor?: string
}

/**
 * Parse and validate offset-based pagination params.
 * Use for stable, countable lists (events, users, favorites).
 */
export function parsePagination(
  page?: number | string,
  limit?: number | string
): PaginationParams {
  return {
    page: boundedInt(page == null ? null : String(page), PAGINATION.DEFAULT_PAGE, 1, Number.MAX_SAFE_INTEGER),
    limit: boundedInt(limit == null ? null : String(limit), PAGINATION.DEFAULT_LIMIT, 1, PAGINATION.MAX_LIMIT),
  }
}

/**
 * A whole number from a query string: `fallback` when it isn't one, then held
 * to [min, max]. `parseInt("abc")` is NaN, and a NaN `take` is a Prisma error
 * the route's catch-all reported as a 500 (SCRUM-430).
 */
export function boundedInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10)
  return Math.min(max, Math.max(min, Number.isNaN(n) ? fallback : n))
}

/**
 * Compute pagination metadata from total count.
 */
export function paginationMeta(
  page: number,
  limit: number,
  totalCount: number
): PaginationMeta {
  return {
    page,
    limit,
    totalCount,
    totalPages: Math.ceil(totalCount / limit),
    hasMore: page * limit < totalCount,
  }
}

/**
 * Compute skip value for Prisma queries.
 */
export function paginationSkip(page: number, limit: number): number {
  return (page - 1) * limit
}

/**
 * Parse cursor-based pagination params.
 * Use for real-time, append-heavy lists (chat messages).
 */
export function parseCursorPagination(
  cursor?: string,
  limit?: number | string
): CursorPaginationParams {
  const l = boundedInt(limit == null ? null : String(limit), PAGINATION.DEFAULT_CHAT_LIMIT, 1, PAGINATION.MAX_LIMIT)
  return { cursor: cursor || undefined, limit: l }
}

/**
 * Build cursor pagination meta.
 * Pass items fetched with limit+1 to detect hasMore.
 */
export function cursorPaginationMeta<T extends { id: string }>(
  items: T[],
  limit: number
): { items: T[]; meta: CursorPaginationMeta } {
  const hasMore = items.length > limit
  const trimmed = hasMore ? items.slice(0, limit) : items
  return {
    items: trimmed,
    meta: {
      limit,
      hasMore,
      nextCursor: hasMore ? trimmed[trimmed.length - 1]?.id : undefined,
    },
  }
}
