import { formatSince } from "@/lib/dashboard-format"

/*
 * A date ahead is said as ahead (SCRUM-314): the Overview's By-organiser table
 * read "today" for Arjun Rao, whose latest published event starts a week out.
 */
const DAY = 24 * 60 * 60 * 1000
const at = (ms: number) => new Date(Date.now() + ms).toISOString()

it.each([
  [7 * DAY + 60_000, "in 7d"],
  [DAY + 60_000, "tomorrow"],
  [60_000, "today"],
  [-60_000, "today"],
  [-DAY - 60_000, "yesterday"],
  [-3 * DAY - 60_000, "3d ago"],
])("%dms from now reads %s", (offset, text) => {
  expect(formatSince(at(offset))).toBe(text)
})
