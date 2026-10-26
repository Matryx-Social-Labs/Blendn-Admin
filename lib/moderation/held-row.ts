// Relative imports only (none needed): the re-check sweeper reaches this from `server.ts`.

/**
 * A "held" row: a big room's line written, then soft-deleted while its text
 * check is awaited (`lib/moderation/degraded-room.ts`). Nothing else leaves a
 * row looking like this: a person's or a moderator's delete sets `deleted_by`,
 * a hide sets `moderation_status`. It is never emitted, so a held row that
 * outlives its request (a process that died mid-wait) is abandoned.
 */
export const HELD_ROW_STALE_MS = 60_000

export interface HeldRowShape {
  deleted_at: Date | null
  deleted_by: string | null
  moderation_status: string | null
}

export const isHeldRow = (row: HeldRowShape): boolean =>
  row.deleted_at !== null && row.deleted_by === null && !row.moderation_status
