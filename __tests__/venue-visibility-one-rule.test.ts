import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

/**
 * One hiding rule, read from one place (HM-G01, plan v2 step 2).
 *
 * When an event takes a venue over — Places leaves the venue out, Go Live is
 * refused, the event's card names the venue — is decided in
 * `lib/venue-visibility.ts`. A second copy (a route spelling its own
 * "not disputed", its own hour before the start) is how the list, the map and
 * the door come to disagree, and no behavioural test fails when they first
 * diverge: each copy is right on its own.
 */

const ROOT = join(__dirname, "..")
const RULE = "lib/venue-visibility.ts"

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

/** Comments describe the rule by name; only code can copy it. */
const code = (abs: string) =>
  readFileSync(abs, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")

const files = ["app", "lib", "scripts"]
  .flatMap((d) => sourceFiles(join(ROOT, d)))
  .map((abs) => [abs.slice(ROOT.length + 1), code(abs)] as const)

/** The undisputed-link read. Writing `"disputed"` (the dispute action) is not a read. */
const DISPUTED_READ = /venue_link_status\s*:\s*\{\s*not\s*:\s*["']disputed["']/
/** The takeover lead, defined. */
const LEAD = /TAKEOVER_LEAD_MINUTES\s*=/

describe("one hiding rule (HM-G01)", () => {
  it("looks at enough of the codebase to mean something", () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it("spells the undisputed-link read in lib/venue-visibility.ts only", () => {
    expect(files.filter(([rel, src]) => rel !== RULE && DISPUTED_READ.test(src)).map(([rel]) => rel)).toEqual([])
    expect(files.find(([rel]) => rel === RULE)?.[1]).toMatch(DISPUTED_READ)
  })

  it("defines the hour before the start in lib/venue-visibility.ts only", () => {
    expect(files.filter(([rel, src]) => LEAD.test(src)).map(([rel]) => rel)).toEqual([RULE])
  })

  it.each([
    ["app/api/mobile/venues/route.ts", /\bvenuesTakenOver\b[\s\S]*from "@\/lib\/venue-visibility"|from "@\/lib\/venue-visibility"[\s\S]*\bvenuesTakenOver\(/],
    ["app/api/mobile/venues/route.ts", /\bundisputedLinkWhere\b/],
    ["lib/services/events.service.ts", /import \{[^}]*\beventVenue\b[^}]*\} from "@\/lib\/venue-visibility"/],
    ["app/api/mobile/venues/[venueId]/route.ts", /import \{[^}]*\beventTakingOver\b[^}]*\} from "@\/lib\/venue-visibility"/],
  ])("%s reads the rule from lib/venue-visibility.ts", (rel, shape) => {
    expect(files.find(([f]) => f === rel)?.[1]).toMatch(shape)
  })

  it("catches the shapes it exists for", () => {
    expect(DISPUTED_READ.test(`{ venue_link_status: { not: "disputed" as const } }`)).toBe(true)
    expect(DISPUTED_READ.test(`data: { venue_link_status: "disputed" }`)).toBe(false)
  })
})
