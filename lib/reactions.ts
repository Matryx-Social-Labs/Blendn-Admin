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
