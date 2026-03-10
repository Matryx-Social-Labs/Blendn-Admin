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
  const p = Math.max(1, Number(page) || PAGINATION.DEFAULT_PAGE)
  const l = Math.min(
    PAGINATION.MAX_LIMIT,
    Math.max(1, Number(limit) || PAGINATION.DEFAULT_LIMIT)
  )
  return { page: p, limit: l }
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
  const l = Math.min(
    PAGINATION.MAX_LIMIT,
    Math.max(1, Number(limit) || PAGINATION.DEFAULT_CHAT_LIMIT)
  )
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
