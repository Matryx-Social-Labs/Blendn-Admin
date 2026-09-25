import { eventWriteAction } from "@/lib/event-cancellation"

/*
 * One name per transition, for both doors (SCRUM-89): the dashboard PATCH and
 * the mobile one audit through this, so a cancel from a phone and a cancel
 * from the dashboard read the same in the audit log.
 */
it.each([
  ["cancelled", "published", "event.cancelled"],
  ["cancelled", "draft", "event.cancelled"],
  ["published", "draft", "event.published"],
  ["published", "published", "event.updated"],
  ["cancelled", "cancelled", "event.updated"],
  [undefined, "published", "event.updated"],
  ["draft", "published", "event.updated"],
] as const)("%s from %s is %s", (next, current, action) => {
  expect(eventWriteAction(next, current)).toBe(action)
})
