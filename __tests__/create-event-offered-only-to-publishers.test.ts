import { readFileSync } from "fs"
import { join } from "path"

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

it("the top bar's Create event pill is offered only when mayCreateEvents says so", () => {
  // The layout asks once per request and hands the answer down; the pill is
  // the one door on every dashboard screen, sponsors and stranded hosts included.
  expect(read("app/dashboard/layout.tsx")).toMatch(/mayCreateEvents\(user\),\s*\]\)/)
  expect(read("app/dashboard/layout.tsx")).toMatch(/canCreate=\{canCreate\}/)
  expect(read("components/site-header.tsx")).toMatch(
    /\{canCreate \? \(\s*<Button asChild pill[\s\S]*?href="\/dashboard\/events\/new"[\s\S]*?\) : null\}/
  )
})
