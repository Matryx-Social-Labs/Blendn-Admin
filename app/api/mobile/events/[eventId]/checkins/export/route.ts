import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { pseudonymsForEvent } from "@/lib/anonymous-names"
import { csvResponse, toCsv } from "@/lib/csv"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { actorFor } from "@/lib/org-membership"
import { eventPermissions, eventPermissionSelect } from "@/lib/rbac"
import {
  unauthorizedResponse,
  notFoundResponse,
  forbiddenResponse,
  serverErrorResponse,
} from "@/lib/api-response"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const { eventId } = await params

    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { id: true, title: true, ...eventPermissionSelect },
    })

    if (!event) {
      return notFoundResponse("Event not found")
    }

    /*
     * An attendee export is `canOperate` — the same bucket as the attendee
     * list on the dashboard. The hand-rolled admin fallback below it existed
     * only because `organizer_id` denied the admin in the first place.
     */
    const requester = await db.user.findUnique({
      where: { id: authUser.userId },
      select: { id: true, role: true },
    })
    if (!requester) return forbiddenResponse("You cannot export attendees for this event")

    const actor = await actorFor({ id: requester.id, role: requester.role })
    if (!eventPermissions(actor, event).canOperate) {
      return forbiddenResponse("You cannot export attendees for this event")
    }

    /*
     * Pseudonymous, like every other host-facing view of a room.
     *
     * This shipped `name`, `email` and `phone` for every attendee, revealed or
     * not. `lib/reports.ts` says in as many words that "an organiser sees who
     * came to their events... and never an email address" and that "attendees
     * are pseudonymous to hosts everywhere in this product, and an export is
     * not a way around that" -- this route was the way around it, and it
     * returned strictly more than the screen it backs.
     *
     * It also hand-rolled its own CSV escaping, which did RFC 4180 quoting and
     * no formula neutralisation, so an attendee could set their display name to
     * `=HYPERLINK(...)` and have it execute in the organiser's spreadsheet.
     * `lib/csv.ts` has handled that since the reports work; the fix is to
     * delete the local copy and use it. That also picks up the UTF-8 BOM and
     * CRLF endings this route lacked, so non-ASCII pseudonyms stop mojibaking
     * in Excel.
     */
    const checkIns = await db.event_check_ins.findMany({
      where: { event_id: eventId },
      orderBy: { check_in_time: "asc" },
    })

    const pseudonyms = await pseudonymsForEvent(eventId)

    const csv = toCsv(
      [
        {
          key: "attendee",
          label: "Attendee",
          value: (ci: (typeof checkIns)[number]) => pseudonyms.get(ci.user_id) ?? "Attendee",
        },
        { key: "status", label: "Status", value: (ci: (typeof checkIns)[number]) => ci.status },
        {
          key: "checkIn",
          label: "Check-in Time",
          value: (ci: (typeof checkIns)[number]) =>
            ci.check_in_time ? ci.check_in_time.toISOString() : "",
        },
        {
          key: "checkOut",
          label: "Check-out Time",
          value: (ci: (typeof checkIns)[number]) =>
            ci.check_out_time ? ci.check_out_time.toISOString() : "",
        },
      ],
      checkIns
    )

    const safeTitle = event.title.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 50)
    return csvResponse(`${safeTitle}_attendees.csv`, csv)
  } catch (error) {
    logger.error("Export attendees error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to export attendees")
  }
}
