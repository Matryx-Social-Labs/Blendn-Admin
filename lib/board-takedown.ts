// Relative imports: lib/board-access.ts reaches this from server.ts's import
// graph (see the note there), and `build:server` emits an alias verbatim.
import { db } from "./db"
import { logger } from "./logger"
import { notifyBoardPostRemoved } from "./push-notifications"

/**
 * Tell a board post's author it was taken down (SV9): the bell row and push
 * (`board_post_removed`), and `board:postRemoved` on their own `user:` room so
 * an open board flips the post at once.
 *
 * Called by the two writers that take a post down against its author's will,
 * and only when this call is the one that took it down: the automatic check
 * (`hideBoardPostIfFlagged`) and a moderator's removal. An author's own
 * withdrawal is not told to the author. One implementation for both, so a
 * third door cannot forget it.
 *
 * Never rejects: the takedown has committed and must not be undone by a push.
 * Goes to the author only, never to the room, and carries ids and nothing of
 * the post's words.
 */
export async function tellAuthorPostTakenDown(postId: string): Promise<void> {
  try {
    const post = await db.board_posts.findUnique({
      where: { id: postId },
      select: { author_id: true, event_id: true },
    })
    if (!post) return
    globalThis.__blendnSocketIo
      ?.to(`user:${post.author_id}`)
      .emit("board:postRemoved", { eventId: post.event_id, postId })
    await notifyBoardPostRemoved(post.author_id, post.event_id, postId)
  } catch (error) {
    logger.error("Telling a board author their post was taken down failed", {
      postId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
