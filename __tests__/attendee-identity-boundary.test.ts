import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

import { stripComments } from "./support/strip-comments"

/**
 * A host never learns who an attendee is. Nothing may select it for them.
 *
 * Owner ruling SCRUM-383 (b), 2026-09-28: organisers, venue owners and
 * sponsors see attendees only as a pseudonymous label plus counts -- never a
 * name, email, phone, photo or profile. `app_admin` keeps full account
 * details for safety and moderation.
 *
 * The roster at `/dashboard/attendees` broke that for as long as it existed.
 * It selected `user: { select: { name: true } }` on every check-in and ran a
 * second `db.user.findMany` for the people who only RSVP'd, and handed an
 * organiser the real name of everybody who came to their past events -- while
 * the CSV export of the same list gave them a label. No test saw it: the
 * source-shape tests checked the email and the user id and nothing else, and
 * the room routes that were fixed for the same leak gate on `isPlatformAdmin`,
 * which this screen never had.
 *
 * Like `authz-scoping-boundary`, this is a grep and deliberately blunt. The
 * integration test (`__tests__/integration/organiser-sees-labels.itest.ts`)
 * holds the serialised output; this holds the source, so a new host surface
 * cannot select a person's identity without somebody deciding it may.
 */

const ROOT = join(__dirname, "..")

const code = (rel: string) => stripComments(readFileSync(join(ROOT, rel), "utf8"))

/**
 * Everything that builds a host's attendee roster: the organisation's, and one
 * event's Attendees tab (SCRUM-499). The event page itself is not listed. It
 * reads `venue.name`, a place and not a person, and the roster reaches it only
 * through `eventAttendees`.
 */
const ROSTER_SOURCES = [
  "lib/attendee-roster.ts",
  "app/dashboard/attendees/page.tsx",
  "app/dashboard/attendees/attendees-table.tsx",
  "app/dashboard/events/[id]/attendees-table.tsx",
]

const IDENTITY = "name|email|image|phone|photos"

describe("the organiser's attendee roster selects no identity", () => {
  it.each(ROSTER_SOURCES)("%s selects no name, email, image or phone", (rel) => {
    const src = code(rel)
    expect(src).not.toMatch(new RegExp(`\\b(${IDENTITY})\\s*:\\s*true`))
    expect(src).not.toMatch(/db\.user\b/)
    expect(src).not.toMatch(/\b(user|profile)\s*:\s*\{/)
    expect(src).not.toMatch(new RegExp(`\\.(${IDENTITY})\\b`))
  })

  it.each(["AttendeeRow", "EventAttendeeRow"])("%s serialises with no field that could carry one", (type) => {
    // The row type is the serialiser's contract: what is not on it cannot
    // reach the client payload.
    const row = code("lib/attendee-roster.ts").match(new RegExp(`export interface ${type} \\{[^}]*\\}`))
    expect(row).not.toBeNull()
    expect(row![0]).not.toMatch(new RegExp(`\\b(${IDENTITY})\\??\\s*:`))
  })

  it("labels both rosters' rows with the export's function and salt, not a second one", () => {
    const src = code("lib/attendee-roster.ts")
    expect(src).toMatch(/import \{ attendeeLabel \} from "\.\/pseudonym"/)
    expect(src).toMatch(/import \{ eventScopeFor, labelScopeFor, labelScoper \} from "\.\/reports"/)
    const [org, event] = src.split("export async function eventAttendees(")
    expect(event).toBeDefined()
    // The organisation's roster: each row salted with its event's organisation.
    expect(org).toMatch(/attendeeLabel\(row\.user_id, labelScope\(row\.event\.organizer_org_id\)\)/)
    // The event's: salted with that event's, both while held back and not.
    expect(event).toMatch(/const scope = labelScopeFor\(actor, event\.organizer_org_id\)/)
    expect(event.match(/id: attendeeLabel\(person, scope\),/g)).toHaveLength(2)
    // And never a label built any other way.
    expect(src.match(/attendeeLabel\(/g)).toHaveLength(3)
  })

  it("renders the event's Attendees tab from the label roster, not a redirect (SCRUM-499)", () => {
    // The tab used to redirect to `/messaging?view=attendees`, which nothing
    // read, so it landed on the room chat.
    const page = code("app/dashboard/events/[id]/page.tsx")
    expect(page).toMatch(/await eventAttendees\(actor, event\.id, now\)/)
    expect(page).toMatch(/<EventAttendeesTable\b/)
    expect(page).not.toMatch(/messaging\?view=/)
  })
})

/*
 * The whole host-facing surface.
 *
 * `app/**` except `app/api/mobile/**`, whose person-to-person rules are
 * `lib/identity.ts`'s (reveal, friends, room handles) and not a host's. A file
 * that selects a person's name, email, image or phone through a person
 * relation, or reads them off `db.user`, must be one of:
 *
 *   - admin-only: it refuses anybody who is not `app_admin`
 *   - admin-gated in the serialiser: `isPlatformAdmin` / `isAdmin ?`, the
 *     shape `chat/messages` and `chat/moderation` use
 *   - on the allowlist below, with the reason it is not an attendee
 *
 * `organizer`, `venue`, `category` are not person relations an attendee sits
 * behind -- an event's host is named on the event itself -- so they are not
 * matched.
 */
const PERSON_RELATION = "user|users|reporter|reported|sender|author|profile|member|members|attendee|rater"

const IDENTITY_READS = [
  new RegExp(`\\b(${PERSON_RELATION})\\s*:\\s*\\{\\s*select\\s*:\\s*\\{[^}]*\\b(${IDENTITY})\\s*:\\s*true`),
  new RegExp(`db\\.user\\.find\\w*\\(\\{[^;]*?\\b(${IDENTITY})\\s*:\\s*true`),
]

const ADMIN_GATE = /role\s*!==\s*"app_admin"|requireAdmin\(|isPlatformAdmin|isAdmin\s*\?/

const ALLOWED = new Map([
  // The caller's own account, by the email they typed.
  ["app/api/auth/forgot-password/route.ts", "the caller's own account"],
  ["app/api/auth/reset-password/route.ts", "the caller's own account"],
  // `sender` of an announcement is the host (or staff) who sent it -- the
  // organisation's own voice, never an attendee.
  ["app/api/events/[id]/announcements/route.ts", "the sender is a host, not an attendee"],
])

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.tsx?$/.test(entry)) acc.push(full)
  }
  return acc
}

describe("no host surface reads a person's identity without an admin gate", () => {
  const files = sourceFiles(join(ROOT, "app"))
    .map((f) => f.replace(`${ROOT}/`, ""))
    .filter((rel) => !rel.startsWith("app/api/mobile/"))

  it("scans a non-trivial number of files, so a bad path cannot empty this test", () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it("finds the gated readers it exists to tolerate, so the patterns still match", () => {
    // If these stop matching, the patterns have rotted and the test below is
    // passing on nothing.
    const hits = files.filter((rel) => IDENTITY_READS.some((p) => p.test(code(rel))))
    expect(hits).toEqual(
      expect.arrayContaining([
        "app/api/events/[id]/chat/messages/route.ts",
        "app/api/events/[id]/chat/moderation/route.ts",
        "app/dashboard/users/actions.ts",
      ])
    )
  })

  it("every identity read is admin-gated or allowlisted with a reason", () => {
    const open = files.filter((rel) => {
      if (ALLOWED.has(rel)) return false
      const src = code(rel)
      return IDENTITY_READS.some((p) => p.test(src)) && !ADMIN_GATE.test(src)
    })
    expect(open).toEqual([])
  })
})

describe("the event's header, loader and QR & link tab reach no person (step 15)", () => {
  /*
   * The pieces step 15 put on every event page. They read the event, the
   * venue's name (a place) and the viewer's permissions, and the QR encodes the
   * event's id — never an attendee, and never who is looking.
   */
  const SOURCES = [
    "lib/event-page.ts",
    "lib/event-share.ts",
    "components/dashboard/event-header.tsx",
    "components/dashboard/event-share.tsx",
    "app/dashboard/events/[id]/messaging/page.tsx",
  ]

  it.each(SOURCES)("%s selects no user, profile, name, email, image or phone", (rel) => {
    // A venue's name is a place, not a person: the one name these may read.
    const src = code(rel).replace(/venue:\s*\{\s*select:\s*\{[^{}]*\}\s*\}/g, "")
    expect(src).not.toMatch(/db\.user\b/)
    expect(src).not.toMatch(/\b(user|profile|organizer|attendees?)\s*:\s*\{/)
    expect(src).not.toMatch(new RegExp(`\\b(${IDENTITY})\\s*:\\s*true`))
    expect(src).not.toMatch(/\.(email|image|phone|photos)\b/)
  })

  it("encodes the event's id in the link and nothing about the viewer", () => {
    const share = code("lib/event-share.ts")
    expect(share).toMatch(/return EVENT_LINK_BASE \+ encodeURIComponent\(eventId\)\s*\n\s*\}/)
    const page = code("app/dashboard/events/[id]/page.tsx")
    expect(page).toMatch(/url=\{eventShareUrl\(event\.id\)\}/)
  })
})
