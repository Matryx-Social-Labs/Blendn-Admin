import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

import { stripComments } from "./support/strip-comments"

/**
 * Nothing writes the time, the venue or the status of an event except through
 * `updateEventTracked` (lib/event-change.ts).
 *
 * "Changed while you're going" (Flow 3) is a record kept at the moment of the
 * write: `events.changed_at` and `changed_from`. A door that writes `start_time`,
 * `end_time`, `venue_name`, `address` or `status` with a bare `events.update`
 * moves the event under the people going and leaves no record and no
 * `event_changed` for them. Three doors were converted when this was written
 * (the dashboard PATCH, the mobile PATCH, the admin status dropdown), and a
 * fourth would not look wrong in a diff: it would look like every other update.
 * So the grep is the enforcement, in the style of `authz-scoping-boundary`.
 *
 * It reads `events.update(` / `events.updateMany(` in `app/` and `lib/`, the
 * argument's brace-matched text, and fails when its `data` names one of the five
 * columns, or is not a literal at all (an indirect `data: payload` cannot be
 * read, so it must be argued for). Raw `UPDATE events` is held to the same.
 *
 * If you are here because this test failed: use `updateEventTracked`. If the
 * write truly must not be a change people are told about, add the file below
 * with the reason, as the existing entries do.
 */

const ROOT = join(__dirname, "..")
const SEARCH_DIRS = ["app", "lib"]
const TRACKED = ["start_time", "end_time", "venue_name", "address", "status"]

/** The one place the record is made. */
const THE_WRITER = "lib/event-change.ts"

/** Files that may write a tracked column outside it, and why that is not a change anybody is told about. */
const ALLOWED: Record<string, string> = {
  "lib/onboarding-actions.ts":
    "Suspending an organisation takes its published events to draft (and restoring puts them back), remembering `pre_suspension_status`. Nobody is TOLD, by design: the event goes dark, and `ORGANISER_SUSPENDED` is what the link says (lib/event-access.ts).",
  "lib/venue-link-actions.ts":
    "Unlinking an event from a venue writes `venue_name: event.venue_name ?? venue.name`: it KEEPS the name the event already shows (\"the event was held there; only the link is wrong\"), so the venue people see does not move. Only the link does, and that is not a time, a place or a status.",
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.tsx?$/.test(entry)) acc.push(full)
  }
  return acc
}

/** The text of the parenthesised argument starting at `open` (index of the "("). */
function argumentAt(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++
    else if (src[i] === ")" && --depth === 0) return src.slice(open + 1, i)
  }
  return src.slice(open + 1)
}

/** The brace-matched text after `data:` in an argument, or `null` when `data` is not an object literal. */
function dataBlock(arg: string): string | null {
  const m = /\bdata\s*:\s*/.exec(arg)
  if (!m) return ""
  const at = m.index + m[0].length
  if (arg[at] !== "{") return null
  let depth = 0
  for (let i = at; i < arg.length; i++) {
    if (arg[i] === "{") depth++
    else if (arg[i] === "}" && --depth === 0) return arg.slice(at, i + 1)
  }
  return arg.slice(at)
}

/** Every offender in a source text: "file:line — why". Exported shape for the control below. */
export function offendersIn(rel: string, raw: string): string[] {
  const src = stripComments(raw)
  const out: string[] = []
  const lineOf = (index: number) => src.slice(0, index).split("\n").length

  for (const m of src.matchAll(/\bevents\s*\.\s*(update|updateMany)\s*\(/g)) {
    const arg = argumentAt(src, m.index + m[0].length - 1)
    const data = dataBlock(arg)
    if (data === null) {
      out.push(`${rel}:${lineOf(m.index)} — events.${m[1]} with a data argument that is not a literal`)
      continue
    }
    // A key of the data block (top level or inside a conditional spread), not a value that happens to say "status".
    const named = TRACKED.filter((c) => new RegExp(`(^|[{,\\s])${c}\\s*[:,}]`).test(data))
    if (named.length) out.push(`${rel}:${lineOf(m.index)} — events.${m[1]} writes ${named.join(", ")}`)
  }
  for (const m of src.matchAll(/UPDATE\s+"?events"?\s+SET\s+([^;`]*)/gi)) {
    const named = TRACKED.filter((c) => new RegExp(`\\b"?${c}"?\\s*=`).test(m[1]))
    if (named.length) out.push(`${rel}:${lineOf(m.index)} — raw UPDATE events sets ${named.join(", ")}`)
  }
  return out
}

describe("events' time, venue and status are written through updateEventTracked", () => {
  const files = SEARCH_DIRS.flatMap((d) => sourceFiles(join(ROOT, d)))
    .map((abs) => abs.slice(ROOT.length + 1).split(/[\\/]/).join("/"))
    .filter((rel) => !rel.startsWith("lib/openapi/"))

  it("scans the source it claims to (a scan of nothing proves nothing)", () => {
    expect(files.length).toBeGreaterThan(300)
    expect(files).toContain(THE_WRITER)
  })

  it("no file outside lib/event-change.ts writes them, but the ones named below", () => {
    const offenders = files
      .filter((rel) => rel !== THE_WRITER && !(rel in ALLOWED))
      .flatMap((rel) => offendersIn(rel, readFileSync(join(ROOT, rel), "utf8")))
    expect(offenders).toEqual([])
  })

  it("every allowance is still needed, so the list shrinks when the code does", () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(offendersIn(rel, readFileSync(join(ROOT, rel), "utf8")).length).toBeGreaterThan(0)
    }
  })

  it("the converted doors really go through it", () => {
    for (const rel of ["app/api/events/[id]/route.ts", "app/api/mobile/events/[eventId]/route.ts", "lib/admin-role-actions.ts"]) {
      expect(stripComments(readFileSync(join(ROOT, rel), "utf8"))).toMatch(/updateEventTracked\(/)
    }
  })

  describe("the scanner itself", () => {
    it("catches a bare write of each tracked column, in a spread and in a raw statement", () => {
      for (const column of TRACKED) {
        expect(offendersIn("x.ts", `await db.events.update({ where: { id }, data: { ${column}: v } })`)).toHaveLength(1)
        expect(offendersIn("x.ts", `await tx.events.updateMany({ where: {}, data: { title, ...(v && { ${column} }) } })`)).toHaveLength(1)
      }
      expect(offendersIn("x.ts", "await db.$executeRaw`UPDATE events SET venue_name = ${v} WHERE id = ${id}`")).toHaveLength(1)
    })

    it("refuses a data argument it cannot read", () => {
      expect(offendersIn("x.ts", "await db.events.update({ where: { id }, data: payload })")).toHaveLength(1)
    })

    it("lets through writes of other columns, other tables and a status that is only a value", () => {
      expect(offendersIn("x.ts", "await db.events.update({ where: { id }, data: { deleted_at: new Date() } })")).toEqual([])
      expect(offendersIn("x.ts", "await db.events.updateMany({ where: { status: 'draft' }, data: { visibility: 'unlisted' } })")).toEqual([])
      expect(offendersIn("x.ts", "await tx.payment_events.update({ where: { id }, data: { status: 'paid' } })")).toEqual([])
    })
  })
})
