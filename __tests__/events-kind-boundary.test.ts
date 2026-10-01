import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

/**
 * A venue day never reaches a reader that did not decide to take it (TQ-X06).
 *
 * A venue day is an `events` row (`kind = 'venue_day'`): one hidden, system-
 * owned event per venue per local day, which is what Go Live checks people
 * into. It is published, it is linked to a venue, it has check-ins and a room —
 * so every reader of `events` that does not ask about `kind` treats it as a
 * real night out. It would appear in the feed, in search, in an organiser's
 * counts, in the reminder sweeper, in the scenario seed's soft-delete sweep.
 *
 * So every reader decides, in one of four ways the test can see:
 *
 *   1. it filters with the shared fragment — `realEventsWhere` (excluded) or
 *      `venueDaysWhere` (only venue days), from `lib/event-kind.ts`;
 *      raw SQL says `kind = 'event'` or `kind = 'venue_day'`;
 *   2. its `where` comes from a variable in the same file, or a scope helper in
 *      `KIND_SCOPED_HELPERS`, that does one of those;
 *   3. it carries an `any-kind: <reason>` comment, in the call or on the lines
 *      just above it, saying why venue days belong in what it reads;
 *   4. it is a by-key lookup — `findFirst`/`findUnique` on one `id` or `slug` —
 *      whose caller already holds the row it means.
 *
 * ## What counts as a reader (F11)
 *
 * Not only `db.events.findMany`. Events are read through relations and raw
 * SQL too, and a guard that looks only where the last bug was is not a ratchet
 * (TESTING-PLAYBOOK §7):
 *
 *   A. `<client>.events.findMany|findFirst|count|groupBy|aggregate|updateMany|deleteMany(`
 *   B. a relation filter inside a `where`: `event: { … }`, `events: { some … }`,
 *      `event: scope`, and `_count: { select: { events: … } }`
 *   C. a template literal with `FROM events` / `JOIN events` (raw SQL)
 *
 * Across `app/`, `lib/`, `components/`, `scripts/` and `server.ts` — `scripts/`
 * because `seed-blr-scenarios --apply` soft-deletes every other Bengaluru
 * event, and a venue day is one (F10).
 *
 * Brace-matched, never `[^}]*` (playbook §2): a relation filter nests.
 */

const ROOT = join(__dirname, "..")
const SEARCH = ["app", "lib", "components", "scripts"]

/** The fragments a reader can name. Kept literal so a rename fails here. */
const PRISMA_MARKER = /\b(?:realEventsWhere|venueDaysWhere)\b/
const SQL_MARKER = /\bkind"?\s*=\s*'(?:event|venue_day)'/
const ANY_KIND = /any-kind:\s*\S.{11,}/

/**
 * Scope helpers whose `where` already carries the fragment. A reader that uses
 * one has decided. Each is verified below to contain a marker (or to delegate
 * to a helper that does), so adding a name here without the filter fails.
 */
const KIND_SCOPED_HELPERS: Record<string, string> = {
  visibleEventsWhere: "lib/event-visibility.ts",
  visibleEventsScope: "lib/event-visibility.ts",
  reportScope: "lib/reports.ts",
  eventScopeFor: "lib/reports.ts",
}

/** Whole files that are about venue days, and so read both kinds by design. */
const FILE_ALLOWLIST: Record<string, string> = {
  "lib/venue-day.ts": "creates and finds venue days; every read here is of venue days on purpose",
  "scripts/seed-volume.ts": "the volume seeder; every statement reads or deletes only its own TAG-prefixed rows",
}

const READ_CALL = /\.events\.(findMany|findFirst|findFirstOrThrow|count|groupBy|aggregate|updateMany|deleteMany)\s*\(/g
const WHERE_CONTEXT = /\bwhere\s*[:=]\s*\{|WhereInput(?:\[\])?\s*(?:\|[^=\n]*)?=\s*[{[]|_count\s*:\s*\{\s*select\s*:\s*\{/g
const RELATION = /\b(events?)\s*:\s*(\{|[A-Za-z_$][\w$]*)/g
const NOT_A_FILTER = /^\{\s*(?:select|include|omit|connect|create|connectOrCreate|disconnect|_count)\b/
const RAW_EVENTS = /`[^`]*\b(?:FROM|JOIN)\s+"?events"?\b[^`]*`/gi

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.tsx?$/.test(entry)) acc.push(full)
  }
  return acc
}

/** Comments replaced by spaces, so offsets in the result are offsets in the source. */
export function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, (m, lead: string) => lead + " ".repeat(m.length - lead.length))
}

/** Index of the bracket closing the one at `open`. Strings are not special-cased; none of these spans needs it. */
export function closing(src: string, open: number): number {
  const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]" }
  const want = pairs[src[open]]
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === src[open]) depth++
    else if (src[i] === want && --depth === 0) return i
  }
  return src.length - 1
}

/** Keys at the top level of an object literal: `{ id, slug: x, ...y }` → id, slug. */
function topLevelKeys(obj: string): string[] {
  const keys: string[] = []
  let depth = 0
  let token = ""
  for (let i = 1; i < obj.length - 1; i++) {
    const c = obj[i]
    if ("{[(".includes(c)) depth++
    else if ("}])".includes(c)) depth--
    if (depth !== 0) continue
    if (c === ":" || c === "," || i === obj.length - 2) {
      const k = (c === ":" || c === "," ? token : token + c).trim()
      if (/^[A-Za-z_$][\w$]*$/.test(k) && (c !== ":" || !keys.includes(k))) keys.push(k)
      token = ""
      if (c === ":") {
        // Skip the value up to the next top-level comma.
        let d = 0
        for (i++; i < obj.length - 1; i++) {
          if ("{[(".includes(obj[i])) d++
          else if ("}])".includes(obj[i])) d--
          else if (obj[i] === "," && d === 0) break
        }
      }
      continue
    }
    token += c
  }
  return keys
}

interface Reader {
  file: string
  line: number
  kind: "call" | "relation" | "raw"
  what: string
  start: number
  end: number
}

interface Scan {
  files: number
  readers: Reader[]
  undecided: Reader[]
}

/** The initializer of every `const|let|var` in the file, by name. */
function declarations(src: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of src.matchAll(/\b(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*/g)) {
    const at = m.index! + m[0].length
    const first = src[at]
    const end = "{[(".includes(first) ? closing(src, at) + 1 : src.indexOf("\n", at)
    const init = src.slice(at, end === -1 ? src.length : end)
    const names = m[1].startsWith("{") ? m[1].slice(1, -1).split(",").map((n) => n.split(":").pop()!.trim()) : [m[1]]
    for (const name of names) if (name) out.set(name, `${out.get(name) ?? ""}\n${init}`)
  }
  // A local helper that builds the where, `function eventScope() { return … }`: its body.
  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)[^{]*\{/g)) {
    const open = m.index! + m[0].length - 1
    out.set(m[1], `${out.get(m[1]) ?? ""}\n${src.slice(open, closing(src, open) + 1)}`)
  }
  return out
}

function decided(text: string, decls: Map<string, string>, hops = 2): boolean {
  if (PRISMA_MARKER.test(text) || SQL_MARKER.test(text)) return true
  if (Object.keys(KIND_SCOPED_HELPERS).some((h) => new RegExp(`\\b${h}\\b`).test(text))) return true
  if (hops === 0) return false
  for (const id of new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
    const init = decls.get(id)
    if (init && decided(init, decls, hops - 1)) return true
  }
  return false
}

function annotated(raw: string, start: number, end: number): boolean {
  const lineStart = raw.lastIndexOf("\n", start) + 1
  let above = lineStart
  for (let n = 0; n < 4 && above > 0; n++) above = raw.lastIndexOf("\n", above - 2) + 1
  return ANY_KIND.test(raw.slice(above, end + 1))
}

export function scanSource(rel: string, raw: string): Reader[] {
  const src = blankComments(raw)
  const lineOf = (i: number) => src.slice(0, i).split("\n").length
  const readers: Reader[] = []

  for (const m of src.matchAll(READ_CALL)) {
    const open = m.index! + m[0].length - 1
    const end = closing(src, open)
    const call = src.slice(open, end + 1)
    // By key: a findFirst, or a single-row count/update/delete, on one `id` or `slug`.
    {
      const where = /\bwhere\s*:\s*\{/.exec(call)
      if (where) {
        const w = call.slice(where.index + where[0].length - 1, closing(call, where.index + where[0].length - 1) + 1)
        const keys = topLevelKeys(w)
        if ((keys.includes("id") || keys.includes("slug")) && !["findMany", "groupBy", "aggregate"].includes(m[1])) {
          const byKey = /\b(?:id|slug)\s*(?::(?!\s*\{)|[,}])/.test(w)
          if (byKey) continue
        }
      }
    }
    readers.push({ file: rel, line: lineOf(m.index!), kind: "call", what: `events.${m[1]}`, start: m.index!, end })
  }

  const seen = new Set<number>()
  for (const ctx of src.matchAll(WHERE_CONTEXT)) {
    const open = ctx.index! + ctx[0].length - 1
    const end = closing(src, open)
    const body = src.slice(open, end + 1)
    for (const r of body.matchAll(RELATION)) {
      const at = open + r.index!
      if (seen.has(at)) continue
      seen.add(at)
      const valueAt = at + r[0].length - r[2].length
      if (r[2] === "{") {
        const relEnd = closing(src, valueAt)
        if (NOT_A_FILTER.test(src.slice(valueAt, relEnd + 1))) continue
        readers.push({ file: rel, line: lineOf(at), kind: "relation", what: `${r[1]}: { … }`, start: at, end: relEnd })
      } else {
        if (/^(?:true|false|null|undefined|string|number|boolean)$/.test(r[2])) continue
        readers.push({ file: rel, line: lineOf(at), kind: "relation", what: `${r[1]}: ${r[2]}`, start: at, end: valueAt + r[2].length })
      }
    }
  }

  for (const m of src.matchAll(RAW_EVENTS)) {
    readers.push({ file: rel, line: lineOf(m.index!), kind: "raw", what: "raw SQL on events", start: m.index!, end: m.index! + m[0].length - 1 })
  }
  return readers
}

function undecidedIn(rel: string, raw: string, readers: Reader[]): Reader[] {
  if (rel in FILE_ALLOWLIST) return []
  const src = blankComments(raw)
  const decls = declarations(src)
  return readers.filter((r) => {
    const text = src.slice(r.start, r.end + 1)
    return !decided(text, decls) && !annotated(raw, r.start, r.end)
  })
}

function scanRepo(): Scan {
  const files = [...SEARCH.flatMap((d) => sourceFiles(join(ROOT, d))), join(ROOT, "server.ts")]
  const readers: Reader[] = []
  const undecided: Reader[] = []
  for (const abs of files) {
    const rel = abs.slice(ROOT.length + 1)
    const raw = readFileSync(abs, "utf8")
    const found = scanSource(rel, raw)
    readers.push(...found)
    undecided.push(...undecidedIn(rel, raw, found))
  }
  return { files: files.length, readers, undecided }
}

describe("every events reader decides about venue days", () => {
  const scan = scanRepo()

  it("scans the whole tree and finds the readers, so a bad path cannot empty this test", () => {
    expect(scan.files).toBeGreaterThan(400)
    expect(scan.readers.filter((r) => r.kind === "call").length).toBeGreaterThan(50)
    expect(scan.readers.filter((r) => r.kind === "relation").length).toBeGreaterThan(20)
    expect(scan.readers.filter((r) => r.kind === "raw").length).toBeGreaterThan(8)
  })

  it("no reader takes venue days without saying so", () => {
    const offenders = scan.undecided.map((r) => `${r.file}:${r.line} — ${r.what}`)
    expect({
      offenders,
      hint: offenders.length
        ? "Add `...realEventsWhere` (lib/event-kind.ts) to the where, `kind = 'event'` to raw SQL, " +
          "or an `any-kind: <why venue days belong here>` comment if they do."
        : "",
    }).toEqual({ offenders: [], hint: "" })
  })

  it.each(Object.entries(KIND_SCOPED_HELPERS))("%s (%s) carries the fragment", (name, rel) => {
    const src = blankComments(readFileSync(join(ROOT, rel), "utf8"))
    // To the next top-level declaration: a return type such as
    // `Promise<{ where: … }>` has braces of its own, so the first `{` is not the body.
    const def = new RegExp(`\\bfunction\\s+${name}\\b`).exec(src)
    expect(def).not.toBeNull()
    const rest = src.slice(def!.index + def![0].length)
    const next = /\n(?:export |async function |function |const |let )/.exec(rest)
    const body = next ? rest.slice(0, next.index) : rest
    const delegates = Object.keys(KIND_SCOPED_HELPERS).some((h) => h !== name && new RegExp(`\\b${h}\\(`).test(body))
    expect(PRISMA_MARKER.test(body) || delegates).toBe(true)
  })

  it("keeps the file allowlist honest: each entry still reads events", () => {
    for (const rel of Object.keys(FILE_ALLOWLIST)) {
      expect(scanSource(rel, readFileSync(join(ROOT, rel), "utf8")).length).toBeGreaterThan(0)
    }
  })
})

/*
 * The scanner against the shapes it exists to catch, and the ones it must let
 * through — so a rule edited into uselessness fails here rather than passing
 * against a codebase that happens to be clean.
 */
describe("the scanner", () => {
  const undecided = (snippet: string) => undecidedIn("x.ts", snippet, scanSource("x.ts", snippet)).length

  it.each([
    ["an unfiltered findMany", `db.events.findMany({ where: { status: "published" } })`],
    ["a bulk soft-delete", `db.events.updateMany({ where: { city: "Bengaluru" }, data: { deleted_at: now } })`],
    ["a count through a variable without the fragment", `const where = { deleted_at: null }\ndb.events.count({ where })`],
    ["a relation filter", `db.event_check_ins.count({ where: { event: { organizer_org_id: { in: orgIds } } } })`],
    ["a nested relation filter", `db.chat_messages.findMany({ where: { chat_group: { event: { status: "published", venue: { city } } } } })`],
    ["a relation filter by variable", `db.event_rsvps.findMany({ where: { event: scope } })`],
    ["a to-many count", `db.venues.findMany({ select: { _count: { select: { events: { where: { status: "published" } } } } } })`],
    ["`some`", `db.categories.findMany({ where: { events: { some: { status: "published" } } } })`],
    ["raw SQL", "db.$queryRaw`SELECT e.id FROM events e WHERE e.status = 'published'`"],
    ["a findFirst on something other than the key", `db.events.findFirst({ where: { venue_id: id, status: "published" } })`],
    ["a findFirst on a set of ids", `db.events.findFirst({ where: { id: { in: ids } } })`],
    ["an updateMany on a set of ids", `db.events.updateMany({ where: { id: { in: ids } }, data: { status: "draft" } })`],
  ])("flags %s", (_label, snippet) => {
    expect(undecided(snippet)).toBe(1)
  })

  it.each([
    ["the fragment", `db.events.findMany({ where: { ...realEventsWhere, status: "published" } })`],
    ["the fragment in a relation", `db.event_check_ins.count({ where: { event: { ...realEventsWhere, organizer_org_id } } })`],
    ["the fragment through a variable", `const where = { ...realEventsWhere, deleted_at: null }\ndb.events.count({ where })`],
    ["a scope helper", `const scope = await visibleEventsWhere(user)\ndb.events.findMany({ where: { ...scope } })`],
    ["raw SQL with the kind", "db.$queryRaw`SELECT e.id FROM events e WHERE e.kind = 'event'`"],
    ["a by-id findFirst", `db.events.findFirst({ where: { id, deleted_at: null } })`],
    ["a by-id findFirst with a value", `db.events.findFirst({ where: { id: params.id, deleted_at: null } })`],
    ["an annotated reader", `// any-kind: one person's own history, venue days labelled as places (D-6)\ndb.events.findMany({ where: { id: { in: ids } } })`],
    ["a select of the relation", `db.event_check_ins.findMany({ where: { user_id }, select: { event: { select: { title: true } } } })`],
    ["an include of the relation", `db.event_rsvps.findMany({ where: { user_id }, include: { event: true } })`],
    ["a connect", `db.event_rsvps.create({ data: { event: { connect: { id } } } })`],
    ["a by-id findUnique", `db.events.findUnique({ where: { id } })`],
    ["a compare-and-set on one row", `db.events.updateMany({ where: { id: event.id, reminded_at: null }, data: { reminded_at: now } })`],
  ])("passes %s", (_label, snippet) => {
    expect(undecided(snippet)).toBe(0)
  })

  it("does not take a commented-out fragment as a decision", () => {
    expect(undecided(`db.events.findMany({ where: { /* ...realEventsWhere, */ status: "published" } })`)).toBe(1)
  })
})

/*
 * PL-G02: only `lib/venue-day.ts` writes a venue day. Everything else that
 * creates events creates the default kind, and the event write schemas never
 * carry `kind` from a request.
 */
describe("venue days have one writer", () => {
  it("no file but lib/venue-day.ts and lib/event-kind.ts names the venue_day kind as a value", () => {
    const offenders = [...SEARCH.flatMap((d) => sourceFiles(join(ROOT, d))), join(ROOT, "server.ts")]
      .map((abs) => [abs.slice(ROOT.length + 1), blankComments(readFileSync(abs, "utf8"))] as const)
      .filter(([rel]) => rel !== "lib/venue-day.ts" && rel !== "lib/event-kind.ts")
      .filter(([, src]) => /\bkind\s*:\s*["']venue_day["']/.test(src))
      .map(([rel]) => rel)
    expect(offenders).toEqual([])
  })

  it("the event write schema has no kind field", () => {
    const src = blankComments(readFileSync(join(ROOT, "lib/validations/event.ts"), "utf8"))
    expect(src).not.toMatch(/\bkind\s*:/)
  })
})
