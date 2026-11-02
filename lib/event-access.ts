// Relative imports — see lib/conversations.ts. Enforced by
// __tests__/server-import-boundary.test.ts.
//
// The routes' answers for an event someone may not see or take part in. The rules themselves
// are lib/event-door.ts (database only, so the custom server can reach them); re-exported here
// so every route keeps importing one module.
import { ErrorCode, errorResponse, notFoundResponse } from "./api-response"
import { suspensionReasonFor, type EventAccessDenial } from "./event-door"

export * from "./event-door"

/** The 404 a route gives for an event that is not there for this person, `reasonCode` included when there is one. */
export async function eventNotFoundResponse(userId: string, eventId: string, message = "Event not found") {
  const { reason } = await suspensionReasonFor(userId, eventId)
  return reason ? errorResponse(message, 404, ErrorCode.NOT_FOUND, reason) : notFoundResponse(message)
}

/**
 * The 403 for `participationRefusal`'s sentence: `FORBIDDEN` and the words as
 * they always were, and `reasonCode: PROFILE_INCOMPLETE` beside them (Flow 15).
 */
export const unfinishedResponse = (sentence: string) =>
  errorResponse(sentence, 403, ErrorCode.FORBIDDEN, ErrorCode.PROFILE_INCOMPLETE)

/** The denial as the response every guarded route returns for it. */
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
  if (denial.kind === "unfinished") return unfinishedResponse(denial.message)
  return denial.reason ? errorResponse("Event not found", 404, ErrorCode.NOT_FOUND, denial.reason) : notFoundResponse("Event not found")
}
