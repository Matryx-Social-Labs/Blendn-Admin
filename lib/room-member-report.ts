import { z } from "zod"

import { db } from "./db"
import { roomScope } from "./room-kind"
import { roomForMember } from "./room-membership"
import { roomMemberFromRef } from "./room-handle"

/**
 * Report a person in a crew's or a Blend's room by the handle the room showed
 * you (`POST /chat/groups/:id/members/:handle/report`). The existing person
 * report (`POST /users/:id/report`) only understands an event room's handle;
 * a crew's or Blend's handle names somebody nowhere but its own room.
 *
 * Filed into `user_reports` like every person report, with the room's kind in
 * the description so a moderator knows where it happened. Who reported is
 * never told to the reported person.
 */
export const reportRoomMemberSchema = z.object({
  reason: z.string().trim().min(1, "Reason is required").max(200),
  description: z.string().trim().max(2000).optional(),
})

export type RoomMemberReportOutcome = "reported" | "not_found" | "self"

export async function reportRoomMember(
  reporterId: string,
  chatGroupId: string,
  ref: string,
  input: z.infer<typeof reportRoomMemberSchema>
): Promise<RoomMemberReportOutcome> {
  // A member of the room, its owner still admitting them (any status: a reporter who was removed may need to).
  const room = await roomForMember(chatGroupId, reporterId, { allowHidden: true })
  if (!room || (room.group.kind !== "crew" && room.group.kind !== "blend")) return "not_found"

  const reportedId = roomMemberFromRef(roomScope(room.group), ref, reporterId)
  if (!reportedId) return "not_found"
  if (reportedId === reporterId) return "self"

  // A handle only means somebody who has a row in this room.
  const inRoom = await db.chat_group_members.findUnique({
    where: { chat_group_id_user_id: { chat_group_id: chatGroupId, user_id: reportedId } },
    select: { id: true },
  })
  if (!inRoom) return "not_found"

  const where = room.group.kind === "crew" ? "In a crew's room." : "In a Blend's room."
  await db.user_reports.create({
    data: {
      reporter_id: reporterId,
      reported_id: reportedId,
      reason: input.reason,
      description: [where, input.description].filter(Boolean).join(" "),
    },
  })
  return "reported"
}
