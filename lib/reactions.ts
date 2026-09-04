/**
 * Reactions as counts, never as names.
 *
 * `docs/CHAT.md:119` states the rule plainly — *"reactions show the count only,
 * never who — who reacted is exactly the kind of thing this room does not
 * disclose"* — and both read paths were shipping `userId` and `userName` for
 * every reaction on every message.
 *
 * The client honoured the rule by rendering only the emoji and a tally, so
 * nothing looked wrong. That is the weakest form of a privacy guarantee: the
 * disclosure was in the payload, one screen away from a client that chose not
 * to draw it, and one `JSON.stringify` away from anybody who looked. A room
 * where liking a message can be traced back to you is a different room from the
 * one this product describes.
 *
 * `mine` is what a client actually needs to render a reaction as pressed, and
 * it is the viewer's own fact about themselves — the one disclosure that costs
 * nothing.
 */
export interface ReactionTally {
  emoji: string
  count: number
  /** Whether the viewer is one of the reactors. */
  mine: boolean
}

export function tallyReactions(
  reactions: Array<{ emoji: string; user_id: string }>,
  viewerId: string
): ReactionTally[] {
  const byEmoji = new Map<string, { count: number; mine: boolean }>()
  for (const r of reactions) {
    const seen = byEmoji.get(r.emoji) ?? { count: 0, mine: false }
    seen.count += 1
    if (r.user_id === viewerId) seen.mine = true
    byEmoji.set(r.emoji, seen)
  }
  /*
   * Sorted, because a Map iterates in insertion order and that is row order —
   * which makes the same message render its reactions in a different sequence
   * depending on what the database happened to return first.
   */
  return [...byEmoji.entries()]
    .map(([emoji, v]) => ({ emoji, count: v.count, mine: v.mine }))
    .sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji))
}

/**
 * The emoji a room may use.
 *
 * An allow-list rather than free text, for two reasons that are not taste.
 * `emoji` is a `String` with no length bound, so an open field is an
 * unbounded write keyed by `(message_id, user_id, emoji)` — one person can
 * mint rows for ever. And a free field is a message: arbitrary text under
 * somebody's post is a channel that bypasses moderation entirely, in the one
 * place the pipeline never looks.
 *
 * Six, deliberately small. `CHAT.md` settles reactions as a light signal, not
 * a vocabulary, and every addition is another column of tally under a message
 * on a phone screen.
 */
export const ALLOWED_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"] as const

export type AllowedReaction = (typeof ALLOWED_REACTIONS)[number]

export function isAllowedReaction(emoji: string): emoji is AllowedReaction {
  return (ALLOWED_REACTIONS as readonly string[]).includes(emoji)
}

/**
 * The room-wide view: counts, and never who.
 *
 * `tallyReactions` needs a viewer because it answers "did *you* react". This
 * one is what goes over the socket to everybody, so it cannot carry `mine` and
 * must not carry a user id — `CHAT.md` is explicit that the room never
 * discloses who reacted, and the socket emitter shipped `userId` to every
 * member of the room until this existed.
 *
 * Each client already knows its own reaction from its own request, so nothing
 * is lost by leaving `mine` out of the broadcast.
 */
export function publicTally(
  reactions: Array<{ emoji: string; user_id: string }>
): Array<{ emoji: string; count: number }> {
  return tallyReactions(reactions, "\u0000never-a-user-id").map(({ emoji, count }) => ({
    emoji,
    count,
  }))
}
