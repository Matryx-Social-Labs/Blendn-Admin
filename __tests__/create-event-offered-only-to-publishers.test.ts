import { readFileSync } from "fs"
import { join } from "path"

import { mayCreateEventsWith } from "@/lib/event-ownership"

/*
 * Every door to the event form asks the same question (SCRUM-145): the Events
 * page's button, the organiser Overview's two, the top bar's pill on every
 * screen, and /events/new itself. The
 * predicate is exercised with real rows in may-create-events.itest.ts; this
 * pins that each screen asks it.
 */
const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8")

it("/events/new sends an account that cannot save an event to the page that says why", () => {
  expect(read("app/dashboard/events/new/page.tsx")).toMatch(
    /if \(!\(await mayCreateEvents\(session\.user\)\)\) \{\s*redirect\("\/dashboard\/organisation"\)/
  )
})

it("the Events page offers the button only when mayCreateEvents says so", () => {
  expect(read("app/dashboard/events/page.tsx")).toMatch(/const canCreate = await mayCreateEvents\(session\.user\)/)
})

it("the organiser Overview is told, and swaps the button for the explanation", () => {
  expect(read("app/dashboard/page.tsx")).toMatch(/<OverviewOrganizer data=\{overview\} canCreate=\{canCreate\} \/>/)
  const overview = read("components/dashboard/overview-organizer.tsx")
  expect(overview.match(/createAction \?\?/g)?.length).toBe(2)
})

it("the top bar's Create event pill is offered only when the same rule says so", () => {
  // The layout has the memberships in hand for the sidebar's card, and asks
  // the pure half of mayCreateEvents with them rather than querying again.
  const layout = read("app/dashboard/layout.tsx")
  expect(layout).toMatch(/const canCreate = mayCreateEventsWith\(user\.role, orgs\.length > 0\)/)
  expect(layout).toMatch(/canCreate=\{canCreate\}/)
  expect(read("lib/event-ownership.ts")).toMatch(
    /export async function mayCreateEvents\([^)]*\)[^{]*\{\s*return mayCreateEventsWith\(/
  )
  expect(read("components/site-header.tsx")).toMatch(
    /\{canCreate && pathname !== "\/dashboard\/events\/new" \? \(\s*<Button asChild pill[\s\S]*?href="\/dashboard\/events\/new"[\s\S]*?\) : null\}/
  )
})

it("mayCreateEventsWith: the role, then a live organisation for anyone but an admin", () => {
  expect(mayCreateEventsWith("app_admin", false)).toBe(true)
  expect(mayCreateEventsWith("organizer", true)).toBe(true)
  expect(mayCreateEventsWith("venue_owner", true)).toBe(true)
  expect(mayCreateEventsWith("organizer", false)).toBe(false)
  expect(mayCreateEventsWith("sponsor", true)).toBe(false)
  expect(mayCreateEventsWith("attendee", true)).toBe(false)
})
