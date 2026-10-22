import { mayShowRealName, type ConversationIdentity } from "./conversation-identity"
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
 * - **Somebody who has revealed to you, or a conversation that never was
 *   pseudonymous, is the real id** — the same rule that shows their name
 *   (`mayShowRealName`), so the id and the name never disagree.
 * - **Everybody else is the handle**, the SAME one on every surface of one
 *   conversation (inbox, detail, messages, socket), so the app can still match a
 *   sender to the other person.
 */
export function idInConversation(
  conversation: ConversationIdentity & { id: string },
  viewerId: string,
  subjectId: string
): string {
  if (subjectId === viewerId || mayShowRealName(conversation, subjectId)) return subjectId
  return roomHandle({ kind: "dm", groupId: conversation.id }, subjectId)
}
