/**
 * Who an announcement is *from*.
 *
 * ## The room is pseudonymous and the host was not
 *
 * Both broadcast routes named the person. The dashboard one built
 * `session.user.name ?? session.user.email ?? "Organiser"` and **persisted it
 * into `chat_messages.content`**, so an organiser with no display name put their
 * email address into a room where every attendee is "Cosmic Panda" — permanently,
 * in the table the sentiment classifier reads and the moderation queue exports.
 * The mobile twin fell back to `"Organiser"` instead of the email, and still
 * emitted the real name above it.
 *
 * ## An announcement is the organisation speaking
 *
 * "Doors close at 11" is the venue talking, not a named employee, and which
 * employee typed it is not information an attendee needs — the audit's decision
 * 7 already draws that line for the roster. Authoring by organisation removes
 * the name and the email fallback in one move, and it survives the person
 * leaving the org, which a snapshotted personal name does not.
 *
 * `created_by` on `event_announcements` still records who typed it. That is an
 * audit question, and it is a different question from whose name appears in
 * the room — the same distinction `organizer_id` versus `organizer_org_id`
 * draws for authorization.
 *
 * ## Why a select fragment
 *
 * Same reason as `eventPermissionSelect`: a query missing `organizer_org` reads
 * as "no organisation" and silently falls back to the generic label, which looks
 * like working code. Spread this rather than hand-picking the relation.
 */

/**
 * The columns `broadcastAuthorName` needs. Spread it; do not hand-pick.
 *
 * Deliberately does **not** reach through `venue`. `eventPermissionSelect`
 * already selects `venue`, and object spread means whichever fragment is
 * written second silently wins — which is the "a select missing `venue` reads
 * as no venue" trap in CLAUDE.md, arriving by a new route. Two fragments that
 * both claim one relation cannot be spread side by side.
 *
 * Nothing is lost by it: R37 removes the venue owner's right to announce into
 * an event they do not run, so the organiser's org is the only author.
 */
export const broadcastAuthorSelect = {
  organizer_org: { select: { display_name: true } },
} as const

export interface BroadcastAuthorEvent {
  organizer_org?: { display_name: string | null } | null
}

/**
 * The generic label, and it is a real answer rather than a failure.
 *
 * An event predating organisations has none — `organizer_org_id` is the column
 * the audit found nothing writes — and a message still needs a name on it.
 * "Organiser" is what the room already expects.
 */
export const GENERIC_AUTHOR = "Organiser"

export function broadcastAuthorName(event: BroadcastAuthorEvent): string {
  return event.organizer_org?.display_name?.trim() || GENERIC_AUTHOR
}
