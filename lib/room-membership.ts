import { db } from "@/lib/db"
import { isUuid } from "@/lib/api-input"
import { chatWindowState, eventHidesRoom } from "@/lib/chat-window"

/**
 * A room and the caller's own row in it, for the routes a member acts on
 * themselves: leave, mute, report.
 *
 * Null for every way the caller has no business with the room — a malformed
 * id, no such room, a draft or deleted event (SCRUM-8, SCRUM-303), no
 * membership row — so each route answers all of them with one 404 and cannot
 * be used to learn which rooms exist.
 *
 * `hidden` rooms are refused here but not by the report route's own reading:
 * see `allowHidden`.
 */
export async function roomForMember(
  chatGroupId: string,
  userId: string,
  opts: { allowHidden?: boolean } = {}
) {
  if (!isUuid(chatGroupId)) return null

  const group = await db.chat_groups.findUnique({
    where: { id: chatGroupId },
    select: {
      id: true,
      event_id: true,
      status: true,
      event: { select: { start_time: true, end_time: true, status: true, deleted_at: true } },
    },
  })
  if (!group) return null
  if (!opts.allowHidden && eventHidesRoom(group.event)) return null

  const membership = await db.chat_group_members.findUnique({
    where: { chat_group_id_user_id: { chat_group_id: chatGroupId, user_id: userId } },
    select: {
      id: true,
      status: true,
      left_at: true,
      muted_at: true,
      banned_by: true,
      notification_preferences: true,
    },
  })
  if (!membership) return null

  /** Whether the room takes writes now — read here, beside the select it needs. */
  const window = chatWindowState(group.event, group)

  return { group, membership, window }
}
