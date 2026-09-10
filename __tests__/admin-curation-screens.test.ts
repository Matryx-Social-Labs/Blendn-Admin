import { readdirSync, readFileSync, existsSync, statSync } from "fs"
import { dirname, join } from "path"

/**
 * The two admin screens curation needs, held to the rules `docs/DESIGN_SYSTEM.md`
 * already settled.
 *
 * The last design review's headline finding was that the plan **re-derived eight
 * decisions fifteen design docs had already made, and got four of them wrong**.
 * So these assert conformance to the doc rather than to a fresh opinion.
 */

const ROOT = join(__dirname, "..")
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

/** Every .ts/.tsx under a directory. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

const CURATE = "app/dashboard/events/curate/page.tsx"
const CLAIMS = "app/dashboard/claims/page.tsx"

describe("DESIGN_SYSTEM rules the docs already settled", () => {
  it("starts page bodies at h2 — the header owns the only h1", () => {
    /*
     * `components/site-header.tsx` owns it and it holds the page NAME. The
     * header once rendered the name as an eyebrow and the description as the
     * h1, which put the wrong string in the document's only landmark heading.
     */
    for (const rel of [CURATE, CLAIMS, "app/dashboard/claims/venues/page.tsx"]) {
      expect(code(rel)).not.toMatch(/<h1[\s>]/)
    }
    expect(code(CURATE)).toMatch(/<h2/)
  })

  it("uses container queries, never viewport breakpoints", () => {
    /*
     * The sidebar is collapsible, so viewport width and content width differ by
     * a large changing amount. The KPI grid and the spotlight grid once used
     * different systems and visibly fell out of step when it collapsed.
     */
    const src = code(CURATE)
    expect(src).toMatch(/@\w+\/main:/)
    expect(src).not.toMatch(/\b(sm|md|lg|xl|2xl):grid-cols/)
  })

  it("does not put a second HeroMetric on a screen", () => {
    /*
     * Exactly one per screen carries the brand gradient. If a second element
     * wants it, the screen has two priorities and one of them is wrong.
     *
     * Neither screen has one at all, deliberately: the curation screen's most
     * important figure is a FAILURE count, and putting the brand gradient
     * behind "3 dead listings" would be celebrating it.
     */
    for (const rel of [CURATE, CLAIMS]) {
      expect((code(rel).match(/<HeroMetric/g) ?? []).length).toBeLessThanOrEqual(1)
    }
  })

  it("says what will fill an empty screen", () => {
    // "Empty says what will fill it", rather than a bare grid that reads as a
    // broken chart.
    expect(code(CURATE)).toMatch(/<EmptyState/)
    expect(code("app/dashboard/claims/event-claims-table.tsx")).toMatch(/<EmptyState/)
  })

  it("orders the queue oldest-first, because age is the SLA", () => {
    /*
     * The rule the moderation queue states. A claimant waiting on an answer is
     * an organiser deciding whether this platform is worth their time, and
     * newest-first buries exactly the ones who have waited longest.
     */
    expect(code("lib/event-claim-actions.ts")).toMatch(/orderBy: \{ created_at: "asc" \}/)
  })
})

describe("one nav entry, two queues", () => {
  it("moves the venue queue rather than adding a third screen", () => {
    /*
     * The plan's admin table is explicit: three claim queues answering one
     * question should be one screen. Separate tables, one job, one sitting —
     * the same argument `QueueSwitch` makes for flags and reports.
     */
    expect(existsSync(join(ROOT, "app/dashboard/claims/venues/page.tsx"))).toBe(true)
    expect(code("lib/dashboard-nav.ts")).not.toMatch(/title: "Venue claims"/)
    expect(code("lib/dashboard-nav.ts")).toMatch(/url: "\/dashboard\/claims"/)
  })

  it("redirects the old URL rather than deleting it", () => {
    /*
     * That URL is in browser histories and possibly in a bookmark. An admin
     * discovering the queue has vanished is worse than one extra file.
     */
    const moved = code("app/dashboard/venue-claims/page.tsx")
    expect(moved).toMatch(/redirect\("\/dashboard\/claims\/venues"\)/)
  })

  it("counts every claim queue in the badge", () => {
    /*
     * One entry with a count for half of it leaves somebody waiting with no
     * number anywhere in the chrome — the reason the moderation badge covers
     * flags AND reports.
     *
     * The sum moved out of `app/dashboard/layout.tsx` and into
     * `lib/attention-queues.ts`, because the overview's attention strip needed
     * the same answer and had been computing a different one. The guard moved
     * with it rather than being deleted: what matters is that all three tables
     * reach one number, not which file adds them up.
     */
    const queues = code("lib/attention-queues-query.ts")
    for (const table of ["event_claims", "venue_claims", "sponsor_claims"]) {
      expect(queues).toMatch(new RegExp(`db\\.${table}\\b`))
    }
    // All three reach ONE row on the strip. Pinned on the fold rather than on
    // the read, because how they are read changed once already — sixteen
    // count/findFirst pairs became eight aggregates — and the guard is about
    // the three queues sharing a badge, not about which Prisma verb does it.
    expect(queues).toMatch(/const claims = \[eventClaims, venueClaims, brandClaims\]/)
    expect(queues).toMatch(/count: sum\(claims\)/)
  })

  it("counts the badge in the server layout, not a client effect", () => {
    // An alert that pops in after paint is one the operator has already
    // scrolled past.
    const layout = code("app/dashboard/layout.tsx")
    expect(layout).not.toMatch(/useEffect|"use client"/)
  })
})

describe("the reviewer can act on what they see", () => {
  const src = code("app/dashboard/claims/event-claims-table.tsx")

  it("shows why a row cannot be decided before the buttons, not after", () => {
    /*
     * `decideEventClaim` re-checks and throws, which is correct and a terrible
     * way to learn it. A reviewer working a queue should see that a row cannot
     * be actioned before they read it.
     */
    expect(src).toMatch(/row\.blocked/)
    expect(src).toMatch(/disabled=\{busy \|\| row\.blocked !== null\}/)
  })

  it("renders the flag copy rather than the flag name", () => {
    // A queue full of `source_is_aggregator` teaches nobody anything.
    expect(src).toMatch(/FLAG_COPY\[flag\]/)
  })

  it("marks the flag that invalidates the others", () => {
    // A reviewer who reads "email matches source" and stops has been misled.
    expect(src).toMatch(/flag === "source_is_aggregator"/)
  })

  it("shows the claim number an upsert would have erased", () => {
    expect(src).toMatch(/claim #\{row\.claimNumber\}/)
  })
})

describe("curation health separates a wrong pin from a dead listing", () => {
  const src = code(CURATE)

  it("distinguishes them by whether anybody tried", () => {
    /*
     * The one number is "ended with zero check-ins", and it catches a wrong
     * pin, a wrong time and a dead listing alike — all three produce identical
     * silence. What separates them is the refusals, which is why
     * `check_in_refusals` had to exist first.
     */
    expect(src).toMatch(/row\.checkedIn === 0 && row\.refused > 0/)
    expect(src).toMatch(/row\.checkedIn === 0 && row\.refused === 0/)
  })

  it("counts people on both sides, not attempts", () => {
    const reader = code("app/dashboard/events/curate/queue-actions.ts")
    expect(reader).toMatch(/turnedAway\.get\(e\.id\)\?\.size/)
    expect(reader).toMatch(/attended\.get\(e\.id\)\?\.size/)
  })

  it("is bounded on both queries", () => {
    const reader = code("app/dashboard/events/curate/queue-actions.ts")
    expect(reader).toMatch(/take: CURATION_PAGE/)
    expect(reader).toMatch(/take: 5_000/)
  })

  it("gates the read half, not only the page", () => {
    /*
     * The moderation queue had exactly this gap: the page redirected non-admins
     * and the action returning the sensitive data did not. This returns contact
     * emails and free-text notes for every pending claim on the platform.
     */
    expect(code("lib/event-claim-actions.ts")).toMatch(/role !== "app_admin"\) throw new Error\("Not authorised"\)/)
    expect(code("app/dashboard/events/curate/queue-actions.ts")).toMatch(/throw new Error\("Not authorised"\)/)
  })
})

describe("the read surface offers the write", () => {
  const src = code(CURATE)

  it("puts the form on the page, not behind a button", () => {
    /*
     * This screen is reached from a city row on the admin overview saying
     * people are waiting there — so the reason somebody is here is to add one.
     * A screen answering "how is curation going" without offering "add another"
     * is the read surface and the write surface on different pages again, which
     * is exactly how `city_demand` came to be written for months and read never.
     */
    expect(src).toMatch(/<CurateForm defaultCity=\{city\} \/>/)
  })

  it("carries the city through from the demand row", () => {
    // The link is `?city=…` from the overview. Losing it would make somebody
    // retype the one fact the previous screen already knew.
    expect(src).toMatch(/searchParams: Promise<\{ city\?: string \}>/)
  })

  it("asks for no image and no description", () => {
    /*
     * Decision 2. There is no field to fill in wrongly, which is a stronger
     * guarantee than a rule somebody has to remember — the description is
     * generated server-side from the facts entered here.
     */
    const form = code("app/dashboard/events/curate/curate-form.tsx")
    expect(form).not.toMatch(/cover_image|description:/)
  })

  it("reuses the one map, rather than adding a third", () => {
    /*
     * K1.1 found two maps in one section disagreeing about where an event was.
     * A third would be a third answer to "where is this".
     */
    const form = code("app/dashboard/events/curate/curate-form.tsx")
    expect(form).toMatch(/from "@\/components\/location-picker"/)
  })

  it("prefers the geocoder's city over anything typed", () => {
    /*
     * The geocoded name is what the feed filters on. A typed "bangalore"
     * against a geocoded "Bengaluru" makes the event invisible in its own city.
     */
    const form = code("app/dashboard/events/curate/curate-form.tsx")
    expect(form).toMatch(/city: location\.city \?\? defaultCity \?\? ""/)
  })

  it("refuses to submit without a pin", () => {
    // `canPublish` would refuse it server-side; saying so before the round trip
    // is the difference between a form and a rejection.
    const form = code("app/dashboard/events/curate/curate-form.tsx")
    expect(form).toMatch(/if \(!location\)/)
  })
})

describe("what the design review found", () => {
  const form = code("app/dashboard/events/curate/curate-form.tsx")

  it("asks for the EVENT's timezone, not the browser's", () => {
    /*
     * The bug the review found. Curation's premise is somebody adding events in
     * cities they are not in, so an admin in London curating a Bengaluru event
     * stored `Europe/London` — and `events.timezone` goes to the mobile client
     * on the detail payload, so attendees saw the wrong local time. It would
     * then surface on the curation-health screen as "nobody came",
     * misattributed to a dead listing by the very screen built to catch it.
     *
     * The browser value seeds the field. It is not the answer.
     */
    expect(form).toMatch(/<TimezoneSelect value=\{field\.value\}/)
    // What is SUBMITTED comes from the field.
    expect(form).toMatch(/timezone: values\.timezone/)
    /*
     * The browser value survives, and should: it seeds `defaultValues` so the
     * common case needs no typing. What matters is that it appears ONLY there —
     * inside the submit path it would be the bug again.
     */
    const submitBody = /const submit = \(values: FormValues\)[\s\S]*?\n  \}/.exec(form)
    expect(submitBody).not.toBeNull()
    expect(submitBody![0]).not.toMatch(/Intl\.DateTimeFormat/)
  })

  it("uses the repo's form primitives, so labels bind to inputs", () => {
    /*
     * The first draft hand-rolled a `Field` wrapper: no htmlFor, no id, so a
     * screen reader saw six unlabelled inputs — and no `FormMessage`, so a
     * short title produced zod's "String must contain at least 3 character(s)"
     * in a toast after a round trip.
     *
     * One swap fixes association, per-field errors and aria-invalid together.
     */
    expect(form).toMatch(/from "@\/components\/ui\/form"/)
    expect((form.match(/<FormField/g) ?? []).length).toBe(6)
    expect((form.match(/<FormMessage \/>/g) ?? []).length).toBe(6)
    expect(form).not.toMatch(/^function Field\(/m)
  })

  it("validates that it ends after it starts, client-side", () => {
    expect(form).toMatch(/It has to end after it starts/)
  })

  it("reports a missing pin where the pin is, not as a toast", () => {
    expect(form).toMatch(/role="alert"/)
    expect(form).toMatch(/setPinError\(/)
  })

  it("stays on the screen after adding, because the city still needs events", () => {
    /*
     * Redirecting to the event page ends the loop — but the demand row that
     * sent you here said twenty-five people are waiting, and one event does not
     * fix that.
     */
    expect(form).toMatch(/Add another for this city/)
    expect(form).not.toMatch(/router\.push\(`\/dashboard\/events\//)
  })

  it("has a loading and an error state on both routes", () => {
    /*
     * Both screens are force-dynamic with three or four round trips, so without
     * a loading state the previous page sits frozen. Five other dashboard
     * sections already had one.
     *
     * **Covered by, not located at.** This asserted a file in each route's own
     * directory, which is a stricter thing than the requirement and it blocked
     * the right fix: `loading.tsx` and `error.tsx` are *segment* boundaries, so
     * one at `app/dashboard/` covers everything beneath it. Both routes had
     * their own `error.tsx` saying exactly what the segment one says, and the
     * duplicates carried a dead branch on `error.message` — unreachable
     * (the pages redirect before they throw) and unusable (Next redacts Server
     * Component messages in production).
     *
     * So the question is whether a boundary covers the route, and the walk up
     * is what asks it.
     */
    const coveredBy = (dir: string, file: string): boolean => {
      let at = join(ROOT, dir)
      const stop = join(ROOT, "app")
      for (;;) {
        if (existsSync(join(at, file))) return true
        if (at === stop) return false
        at = dirname(at)
      }
    }

    for (const dir of ["app/dashboard/claims", "app/dashboard/events/curate"]) {
      expect(coveredBy(dir, "loading.tsx")).toBe(true)
      expect(coveredBy(dir, "error.tsx")).toBe(true)
    }
  })

  it("admits when a list is capped", () => {
    /*
     * `take: 100` with nothing saying so reads as "this is all of them", and an
     * admin who believes that concludes curation is healthier than it is. The
     * same no-silent-caps rule this codebase applies to bounded backend
     * queries, applied to the screen that renders one.
     */
    expect(code(CURATE)).toMatch(/Showing the \{CURATION_PAGE\} most recent of \{total\}/)
    expect(code(CLAIMS)).toMatch(/Showing the \{CLAIM_PAGE\} longest-waiting of \{total\}/)
    expect(code("app/dashboard/events/curate/queue-actions.ts")).toMatch(/db\.events\.count\(\{ where \}\)/)
  })

  it("leads with the number that prompts an action", () => {
    /*
     * It led with "Curated", a count that only goes up. DESIGN_SYSTEM.md's
     * central correction is that the forward-looking question comes before any
     * trailing report.
     */
    const src = code(CURATE)
    expect(src.indexOf("Likely a wrong pin")).toBeLessThan(src.indexOf('label="Curated"'))
  })
})

describe('"use server" files export only async functions', () => {
  it("keeps value exports out of every one of them", () => {
    /*
     * A `"use server"` module may only export async functions. An
     * `export const` there is a build error that NEITHER tsc NOR the unit suite
     * sees — only `next build` does, which is why this guard exists.
     *
     * **It was a hardcoded list of three files, and it did not catch the second
     * instance.** `VENUE_INDEX_PAGE` went into `app/dashboard/actions.ts`,
     * which was not on the list, and the failure surfaced as a blank screen in
     * a browser after tsc, eslint and 2440 unit tests were all green.
     *
     * A guard that only looks where the last bug was is not a ratchet. It walks
     * the tree now: every `"use server"` file, found by reading them, so a new
     * one is covered the moment it exists.
     */
    const files = [...sourceFiles(join(ROOT, "app")), ...sourceFiles(join(ROOT, "lib"))].filter(
      (f) => /^\s*["']use server["']/.test(readFileSync(f, "utf8"))
    )

    // Guards the guard: an empty list would pass vacuously, and the detection
    // is a regex over the first line of a file.
    expect(files.length).toBeGreaterThan(5)

    const offenders: string[] = []
    for (const file of files) {
      const src = readFileSync(file, "utf8")
      for (const m of src.matchAll(/^export (?!async function|interface|type |default )(\w+)/gm)) {
        offenders.push(`${file.slice(ROOT.length + 1)} exports \`${m[1]}\``)
      }
    }
    expect(offenders).toEqual([])
  })
})
