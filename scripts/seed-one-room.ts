import type { PrismaClient } from "@prisma/client"

/**
 * One open check-in per person (SCRUM-705): the database refuses a second
 * open row (`event_check_ins_one_open_per_user`), so a seed that puts somebody
 * in a room moves them out of any other first, as the door does.
 *
 * Never departed before they arrived: a seed can place someone in a room at a
 * time earlier than their arrival in the room they are leaving, and
 * `presence_sessions_departure_after_arrival` refuses a departure stamped
 * before the arrival (it crashed `seed-blr-scenarios --apply`, review H1).
 * GREATEST in SQL, so each row is judged against its own arrival.
 */
export async function leaveOtherRooms(db: Pick<PrismaClient, "$executeRaw">, userId: string, occurrenceId: string, at: Date) {
  await db.$executeRaw`
    UPDATE event_check_ins
       SET status = 'checked_out', check_out_time = GREATEST(check_in_time, ${at}::timestamptz), updated_at = now()
     WHERE user_id = ${userId} AND status = 'checked_in' AND occurrence_id <> ${occurrenceId}::uuid`
  await db.$executeRaw`
    UPDATE presence_sessions
       SET departed_at = GREATEST(arrived_at, ${at}::timestamptz), departed_source = 'switch', updated_at = now()
     WHERE user_id = ${userId} AND departed_at IS NULL AND occurrence_id <> ${occurrenceId}::uuid`
}
