/**
 * The status moves a client may make (lib/event-status-move.ts). The routes
 * that apply it are driven in `integration/event-status-moves.itest.ts`.
 */
import { UNCANCEL_REFUSAL } from "@/lib/event-cancellation"
import {
  CANCEL_DRAFT_REFUSAL,
  COMPLETED_REFUSAL,
  CREATE_STATUS_REFUSAL,
  FROM_COMPLETED_REFUSAL,
  statusMoveRefusal,
} from "@/lib/event-status-move"

it.each([
  // create
  [undefined, null, null],
  ["draft", null, null],
  ["published", null, null],
  ["cancelled", null, CREATE_STATUS_REFUSAL],
  ["completed", null, CREATE_STATUS_REFUSAL],
  // no move
  [undefined, "published", null],
  ["completed", "completed", null],
  ["cancelled", "cancelled", null],
  // from a draft
  ["published", "draft", null],
  ["cancelled", "draft", CANCEL_DRAFT_REFUSAL],
  ["completed", "draft", COMPLETED_REFUSAL],
  // from published
  ["draft", "published", null],
  ["cancelled", "published", null],
  ["completed", "published", COMPLETED_REFUSAL],
  // terminal
  ["published", "cancelled", UNCANCEL_REFUSAL],
  ["draft", "cancelled", UNCANCEL_REFUSAL],
  ["published", "completed", FROM_COMPLETED_REFUSAL],
  ["draft", "completed", FROM_COMPLETED_REFUSAL],
] as const)("%s from %s → %s", (next, current, expected) => {
  expect(statusMoveRefusal(next, current)).toBe(expected)
})
