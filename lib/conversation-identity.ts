/**
 * What one participant is called, to the other.
 *
 * ## Why this has to be one function
 *
 * A DM that opens from a mutual like carries the **same pseudonym the match
 * card showed**, and the real name appears only when that person chooses to
 * reveal. That rule was about to be true of the message list and false
 * everywhere else, because two paths reached for `profiles.name` directly and
 * neither knew anything about revealing:
 *
 *     lib/socket-server.ts   userName: profile?.name || "Someone"   ← on every keystroke
 *     conversations/.../messages/route.ts   const senderName = message.sender.name   ← push TITLE
 *
 * So under the pseudonymous model, A starts typing and B's screen would say
 * *"Priya Raman is typing…"*; A sends anything and B's **lock screen** would say
 * *"Priya Raman"*. The pseudonym would survive exactly until the first
 * keystroke. That is the same shape as the bug already commented at
 * `MatchScreen.tsx:513` — *"the anonymity was one tap deep"*.
 *
 * Every surface that names a participant resolves through here.
 *
 * ## The three states, and why null is not "anonymous"
 *
 *   pseudonym  revealed   shown as        because
 *   ─────────  ────────   ────────        ───────
 *   null       either     real name       never was pseudonymous
 *   set        false      pseudonym       matched, has not revealed
 *   set        true       real name       matched, revealed
 *
 * A **null pseudonym means this conversation did not come from a match** — an
 * accepted message request, which has shown real names since it existed and
 * must keep doing so. Reading null as "anonymous" would retro-anonymise every
 * conversation in the database, which is both wrong and a worse bug than the
 * one this fixes.
 *
 * That is also what makes this shippable ahead of the reveal work: nothing
 * writes pseudonyms yet, so today every conversation takes the first row and
 * behaviour is unchanged.
 */

/** The columns this needs. A subset, so callers can select narrowly. */
export interface ConversationIdentity {
  user1_id: string
  user2_id: string
  user1_pseudonym: string | null
  user2_pseudonym: string | null
  user1_revealed: boolean
  user2_revealed: boolean
}

/** A safe last resort. Never an email local part, never an id. */
export const UNNAMED = "Someone"

/**
 * What `subjectId` is called inside this conversation.
 *
 * `realName` is the caller's — it is only *returned* when this person has
 * earned it being shown, so passing it in is not a leak, but passing it to the
 * client without going through here is.
 */
export function displayNameInConversation(
  conversation: ConversationIdentity,
  subjectId: string,
  realName: string | null | undefined
): string {
  const clean = typeof realName === "string" && realName.trim() ? realName.trim() : null

  const isUser1 = conversation.user1_id === subjectId
  const isUser2 = conversation.user2_id === subjectId
  // Not a participant. Naming them here would be inventing an identity for
  // somebody the conversation has nothing to say about.
  if (!isUser1 && !isUser2) return UNNAMED

  const pseudonym = isUser1 ? conversation.user1_pseudonym : conversation.user2_pseudonym
  const revealed = isUser1 ? conversation.user1_revealed : conversation.user2_revealed

  // Never pseudonymous — a message-request conversation. Real names, as always.
  if (!pseudonym) return clean ?? UNNAMED

  if (revealed) {
    /*
     * Revealed, but with nothing to reveal.
     *
     * Falling back to the pseudonym rather than to "Someone": the person they
     * have been talking to for a week does not silently become a stranger
     * because a name is missing.
     */
    return clean ?? pseudonym
  }

  return pseudonym
}

/**
 * Is `viewerId` allowed to see `subjectId`'s real name in this conversation?
 *
 * The same rule as above, as a predicate, for callers deciding whether to send
 * a photo or a profile rather than a string. `viewerId` is unused today — the
 * rule is symmetric, since revealing is a standing offer shown to whoever is on
 * the other side — but it is in the signature because a future per-viewer rule
 * (a block, a report) belongs here rather than at ten call sites.
 */
export function mayShowRealName(
  conversation: ConversationIdentity,
  subjectId: string
): boolean {
  const isUser1 = conversation.user1_id === subjectId
  const isUser2 = conversation.user2_id === subjectId
  if (!isUser1 && !isUser2) return false

  const pseudonym = isUser1 ? conversation.user1_pseudonym : conversation.user2_pseudonym
  if (!pseudonym) return true

  return isUser1 ? conversation.user1_revealed : conversation.user2_revealed
}
