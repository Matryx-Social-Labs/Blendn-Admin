/**
 * Whether a sender may be told their message was read.
 *
 * `profiles.read_receipts` was written by the settings screen and read by
 * nothing: the switch was a round trip to itself. Turning it off changed no
 * behaviour anywhere, which is worse than not offering it — somebody who
 * believes they have turned read receipts off behaves as though they have.
 *
 * The rule lives here because it is needed on two surfaces that would
 * otherwise drift. The socket relays `private:read` the moment a message is
 * opened; the conversation list reports `lastMessage.isRead`, which **is** a
 * read receipt whenever the last message is the caller's own. Honouring the
 * setting on the socket alone would leak the same fact one screen away, which
 * is exactly how the room's reaction disclosure survived.
 */

/**
 * Reading is recorded either way. The setting governs DISCLOSURE, not state.
 *
 * Marking a message read is the reader's own business: it clears their unread
 * badge and decides what the app shows them next. Suppressing the write as
 * well would leave someone with read receipts off staring at a badge that
 * never cleared — a settings toggle silently breaking an unrelated feature,
 * which is how people learn not to touch settings.
 */
export const READ_IS_ALWAYS_RECORDED = true

/**
 * What to report for `isRead` on a message in a conversation.
 *
 * `senderIsViewer` is the whole question. When the viewer sent it, `isRead`
 * describes the *other* person's behaviour and is theirs to withhold. When
 * somebody else sent it, `isRead` is the viewer's own state and telling them
 * about it discloses nothing.
 */
export function isReadForViewer(opts: {
  senderIsViewer: boolean
  isRead: boolean
  /** The other party's `read_receipts`. Null/undefined profile means default on. */
  otherPartyAllowsReceipts: boolean | null | undefined
}): boolean {
  if (!opts.senderIsViewer) return opts.isRead
  // Default ON when unset: the column is nullable and most rows predate the
  // setting existing. Defaulting to silence would turn read receipts off for
  // every account that never opened settings.
  const allows = opts.otherPartyAllowsReceipts ?? true
  return allows ? opts.isRead : false
}
