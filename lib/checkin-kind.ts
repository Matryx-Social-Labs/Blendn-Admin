import type { check_in_kind } from "@prisma/client"

import type { PermissionActor } from "@/lib/rbac"

/**
 * Working, or attending?
 *
 * Organisers and venue staff check in through the same button as everyone else.
 * **The client app is not changing** — no second page, no "check in as staff",
 * no new roles. It does not need to, because the server already knows: a
 * check-in is staff work if the person's organisation runs the event or owns
 * the venue it is held at.
 *
 * Keyed on **organisation membership, not role**, deliberately. An `app_admin`
 * has no `orgIds`, so a support visit counts as an attendee — inflating guest
 * attendance by one, which is a far smaller distortion than silently excluding
 * them from a number the organiser is reading. And an organiser attending
 * *someone else's* event is correctly a guest, which a role check would get
 * wrong.
 */
export function checkInKindFor(
  actor: Pick<PermissionActor, "orgIds">,
  event: {
    organizer_org_id: string | null
    venue?: { owner_org_id: string | null } | null
  }
): check_in_kind {
  const runsIt =
    event.organizer_org_id !== null && actor.orgIds.includes(event.organizer_org_id)

  const ownsVenue =
    event.venue?.owner_org_id != null && actor.orgIds.includes(event.venue.owner_org_id)

  return runsIt || ownsVenue ? "staff" : "attendee"
}
