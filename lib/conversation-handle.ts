import { isPseudonymous, type ConversationIdentity } from "./conversation-identity"
import { roomHandle } from "./room-handle"

// Relative imports and no database: the custom server (lib/socket-server.ts)
// reaches this, and its import graph may not touch an `@/` alias.

/**
 * The id a direct conversation shows for the other person (SCRUM-752 follow-up).
 *
 * A match's other side is a pseudonym until THEY reveal to you, and the inbox
 * used to send their account id beside it. Every other surface holds that id and
 * a name (the friends list, a message request, a crew, a friend request), so the
 * id was a join key that undid the pseudonym client-side, with no server check
 * to refuse. So until they reveal, the conversation names them by a handle
 * scoped to the conversation (`room-handle.ts`, kind `dm`) — unlinkable to the
 * id, to a room's handle for them, and to another conversation.
 *
 * - **You are always your real id**, as in every room: the app compares its own.
 * - **A conversation that never was pseudonymous** (an accepted message
 *   request) **is the real id.**
 * - **In a match's or a board post's chat the other person is the handle,
 *   swapped or not** -- the SAME one on every surface of one conversation
 *   (inbox, detail, messages, socket), so the app can still match a sender to
 *   the other person. A swap shows a first name and photo in this chat only
 *   (identity model); the real id would be a join key to every list that
 *   carries it beside a full name (review of #1001). `POST /friends/requests`,
 *   block and report take the handle.
 */
export function idInConversation(
  conversation: ConversationIdentity & { id: string },
  viewerId: string,
  subjectId: string
): string {
  if (subjectId === viewerId || !isPseudonymous(conversation)) return subjectId
  return roomHandle({ kind: "dm", groupId: conversation.id }, subjectId)
}
