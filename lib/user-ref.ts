import { userIdFromDmRef } from "./conversation-ref"
import { openRoomHandle, userIdFromRef } from "./room-handle"
import { ownerAdmits } from "./room-kind"

/**
 * Who a safety action (block, report) names.
 *
 * A raw id or an event room's handle as `userIdFromRef` reads them; a direct
 * conversation's handle names the other person in it. A handle from a room that
 * is not an event's -- a Blend, a crew's chat, a board post's room -- names
 * somebody only to a caller that room's door lets in now: acting on somebody
 * from inside a Blend is the one thing a Blend handle may do outside the
 * Blend, and only for the people in it. For anybody else it stays the handle,
 * which names nobody (404, as for an id nobody has).
 *
 * Block resolved these and report did not (SCRUM-623): in a Blend full of
 * strangers you could block a person but not report them. One resolver, both
 * routes, so they cannot disagree again.
 */
export async function userTargetFromRef(viewerId: string, ref: string): Promise<string> {
  const opened = openRoomHandle(ref)
  if (!opened || typeof opened.scope === "string") return userIdFromRef(ref)
  // A conversation's handle: the other person of a DM you are in, whether or not they have revealed.
  if (opened.scope.kind === "dm") return (await userIdFromDmRef(viewerId, ref)) ?? ref
  return (await ownerAdmits(opened.scope.groupId, [viewerId]))?.has(viewerId) ? opened.userId : ref
}
