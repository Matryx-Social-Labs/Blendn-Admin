// Relative imports: the photo recheck runs from the chat-lifecycle sweeper, which server.ts reaches.
import type { board_photo_status } from "@prisma/client"

import { db } from "./db"
import { logger } from "./logger"
import { checkImageContent, type ModerationCheck } from "./moderation/openai-moderation"
import { forcedHide } from "./moderation/staging-override"
import { readableUrl } from "./tigris"

/**
 * A Lobby post's one photo (SCRUM-1026, owner decision 1).
 *
 * The upload is the DM photo's path: a presigned PUT under the sender's own
 * `chat/<id>/`, then `sealChatMedia` on the post — the server's own copy, its
 * EXIF and GPS stripped (`stripImageMetadata`), in the private bucket under a
 * key that names nobody (`chat/sealed/<uuid>`). The post stores that copy.
 *
 * Then it waits. A photo is `pending` until OpenAI's omni-moderation (free,
 * images included) has looked at it, and while it waits only its author is
 * given a URL. Approved, everybody who can read the Lobby is; rejected, nobody
 * is, and the row and object are kept for the 180 days removed content is
 * (`lib/lobby-retention.ts`). A borderline `flag` is a rejection here: the
 * photo is held until it is approved, and a maybe is not a yes.
 */

export interface LobbyPhoto {
  status: board_photo_status
  /** A signed URL valid for 15 minutes; null for a rejected photo. */
  url: string | null
  alt: string | null
}

/** What a viewer is shown of a post's photo, if anything. Others never get a pending or rejected photo's URL. */
export async function photoFor(
  post: { author_id: string; photo_url: string | null; photo_status: board_photo_status | null; photo_alt: string | null },
  viewerId: string
): Promise<LobbyPhoto | null> {
  if (!post.photo_url || !post.photo_status) return null
  if (post.photo_status === "approved") return { status: "approved", url: await readableUrl(post.photo_url), alt: post.photo_alt }
  if (post.author_id !== viewerId) return null
  if (post.photo_status === "rejected") return { status: "rejected", url: null, alt: null }
  return { status: "pending", url: await readableUrl(post.photo_url), alt: post.photo_alt }
}

/** Retries before a vendor hiccup counts: these run after the response or in the sweep, never under a person's request. */
const PHOTO_CHECK = { retries: 2 } as const

/** The verdict a check gives a pending photo; null when it could not look (it stays pending, and the sweep tries again). */
export function photoVerdict(check: ModerationCheck): "approved" | "rejected" | null {
  if (!check.checked) return null
  return check.result && check.result.action !== "allow" ? "rejected" : "approved"
}

/**
 * Judge a post's pending photo. Writes only a photo still pending, so a second
 * pass (the sweep racing the post's own check) changes nothing. Never rejects.
 */
export async function moderateLobbyPhoto(postId: string, check = checkImageContent): Promise<"approved" | "rejected" | null> {
  try {
    const post = await db.board_posts.findUnique({
      where: { id: postId },
      select: { author_id: true, photo_url: true, photo_status: true },
    })
    if (!post?.photo_url || post.photo_status !== "pending") return null
    const verdict = photoVerdict(forcedHide(post.author_id) ?? (await check(await readableUrl(post.photo_url), PHOTO_CHECK)))
    if (!verdict) return null
    const { count } = await db.board_posts.updateMany({
      where: { id: postId, photo_status: "pending" },
      data: { photo_status: verdict, photo_checked_at: new Date() },
    })
    if (count > 0 && verdict === "rejected") logger.warn("Lobby photo rejected by moderation", { postId })
    return count > 0 ? verdict : null
  } catch (error) {
    logger.error("Lobby photo moderation failed; photo left pending", {
      postId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/** How long a photo waits for its own check before the sweep takes it. */
export const PHOTO_RECHECK_AFTER_MS = 2 * 60 * 1000
/** Photos per sweep pass: the vendor is rate-limited. */
const PHOTO_RECHECK_BATCH = 20

/** Pending photos whose first check did not land (an outage, a restart), oldest first. */
export async function recheckPendingPhotos(now: Date = new Date(), check = checkImageContent): Promise<number> {
  const pending = await db.board_posts.findMany({
    where: { photo_status: "pending", deleted_at: null, created_at: { lt: new Date(now.getTime() - PHOTO_RECHECK_AFTER_MS) } },
    orderBy: { created_at: "asc" },
    take: PHOTO_RECHECK_BATCH,
    select: { id: true },
  })
  let decided = 0
  for (const { id } of pending) if (await moderateLobbyPhoto(id, check)) decided++
  return decided
}
