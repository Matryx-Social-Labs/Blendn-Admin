// Relative imports — see lib/conversations.ts. Enforced by
// __tests__/server-import-boundary.test.ts.
//
// The routes' answers for an event someone may not see or take part in. The rules themselves
// are lib/event-door.ts (database only, so the custom server can reach them); re-exported here
// so every route keeps importing one module.
import { ErrorCode, errorResponse, forbiddenResponse, notFoundResponse } from "./api-response"
import { suspensionReasonFor, type EventAccessDenial } from "./event-door"

export * from "./event-door"

/** The 404 a route gives for an event that is not there for this person, `reasonCode` included when there is one. */
export async function eventNotFoundResponse(userId: string, eventId: string, message = "Event not found") {
  const { reason } = await suspensionReasonFor(userId, eventId)
  return reason ? errorResponse(message, 404, ErrorCode.NOT_FOUND, reason) : notFoundResponse(message)
}

/**
 * The denial as the response every guarded route returns for it. A known
 * too-young age (an event's minimum, or an account known to be under 18) is
 * `AGE_RESTRICTED` in both fields; an unfinished profile is `FORBIDDEN` with
 * `reasonCode: PROFILE_INCOMPLETE` (Flow 15).
 */
export function eventAccessResponse(denial: EventAccessDenial) {
  if (denial.kind === "age") {
    return errorResponse(
      denial.message,
      403,
      ErrorCode.AGE_RESTRICTED,
      // Too young is the code it always was, said in the new field too, so the app reads one place.
      denial.unknownAge ? ErrorCode.AGE_UNKNOWN : ErrorCode.AGE_RESTRICTED
    )
  }
  if (denial.kind === "unfinished") return errorResponse(denial.message, 403, ErrorCode.FORBIDDEN, ErrorCode.PROFILE_INCOMPLETE)
  return denial.reason ? errorResponse("Event not found", 404, ErrorCode.NOT_FOUND, denial.reason) : notFoundResponse("Event not found")
}

/**
 * `participationRefusal`'s answer on the three messaging routes (`POST
 * /conversations`, `POST /message-requests`, `POST /conversations/:id/messages`):
 * an unfinished profile is a plain `FORBIDDEN` with no `reasonCode`, as these
 * routes have always answered; an account known to be under 18 is
 * `eventAccessResponse`'s `AGE_RESTRICTED`, as everywhere.
 */
export function messagingRefusalResponse(denial: EventAccessDenial) {
  return denial.kind === "unfinished" ? forbiddenResponse(denial.message) : eventAccessResponse(denial)
}
