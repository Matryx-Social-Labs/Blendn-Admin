import { readFileSync, readdirSync, statSync, existsSync } from "fs"
import { join } from "path"

import { stripComments } from "./support/strip-comments"

/**
 * Every export in `lib/` is called by something.
 *
 * ## Why this exists
 *
 * This codebase has now produced the same bug many times over: a capability is
 * fully built, typechecked, usually unit-tested — and called by nothing.
 * `may_sponsor` with no writer. `canSendSystemMessages` with no caller.
 * `likeAtEvent` with no caller. `stopAllOpsBroadcasts` with no caller. Two
 * sponsor nav items pointing at pages that did not exist. Every one shipped
 * green, because nothing in `tsc`, `jest` or `eslint` asks "can anybody get
 * here".
 *
 * The expensive version of this bug is not the wasted code. It is documentation
 * that becomes false. `lib/venue-claim-actions.ts` argues that its review bar
 * can be relaxed because "auto-link is reversible — an organiser can unlink any
 * event from a venue". That sentence is load-bearing for a security posture, and
 * it is false while `unlinkEventVenue` has no caller.
 *
 * ## Two holes this used to have
 *
 * It scanned only `lib/` modules whose first line is `"use server"`. That is a
 * fraction of the write surface, and every dead export a later audit turned up
 * — `isRoleAddressFor`, `canPublish`, `notifyEventCancelled`, `getTrustSignal`
 * — sat outside it, invisible. It now scans every exported function in `lib/`.
 *
 * And `callersOf` was a word-boundary match over raw file text, so a name that
 * appeared only in a **comment** counted as a caller. `escalates` was precisely
 * that: mentioned in prose in `lib/sentiment-sweeper.ts` and
 * `components/dashboard/charts.tsx`, called from nowhere, and passing. A
 * reachability check that counts a mention is worse than no check — it converts
 * an unknown into a false assurance. Source is stripped of comments first.
 *
 * ## Ratchet, not allowlist
 *
 * `KNOWN_UNREACHABLE` is checked in both directions. A new dead export fails,
 * and so does a *stale* entry — wire one up and this test tells you to delete
 * the line. An allowlist that only ever grows is how this class of bug survived
 * so many rounds.
 */

const ROOT = join(__dirname, "..")

/**
 * Everything that can legitimately call into `lib/`.
 *
 * The root files matter as much as the directories: `server.ts` is the real
 * production entrypoint, and without it `initSocketServer`, `validateEnv`,
 * `ensureBucketExists` and every `stop*Sweeper` read as dead. `scripts/` counts
 * too — a maintenance script is a caller. It is not a *user* path, but the
 * failure being caught here is "nothing calls this at all", and a script that
 * an operator runs is a real answer to it.
 *
 * `__tests__` is deliberately absent. A test is not reachability; being called
 * only by its own unit test is the exact shape of the bug.
 */
const CALLER_DIRS = ["lib", "app", "components", "hooks", "scripts"]
const CALLER_FILES = [
  "server.ts",
  "middleware.ts",
  "instrumentation.ts",
  "instrumentation-client.ts",
  "sentry.server.config.ts",
  "sentry.edge.config.ts",
  "prisma/seed.ts",
]

/**
 * Built, tested, and reachable by nobody. Each line is a missing screen or a
 * missing wire, not a decision to leave the code dead — so each says which.
 *
 * Deleting one of these is usually the wrong move: most are the half of a
 * feature that makes the other half honest, and dropping them would quietly
 * ratify a false docblock rather than fix it.
 */
const KNOWN_UNREACHABLE = new Map<string, string>([
  // --- Surfaced only by the merged tree, and owned by another workstream -----
  //
  // Both were dead on their own branch too; nothing there could see it, because
  // the ratchet that finds them (#269) and the code that contains them (#264)
  // never sat in one tree until now. R32 says dead code is deleted by the
  // workstream that owns its area, reviewed next to whatever replaces it -- so
  // they are recorded here rather than removed blind by a merge.
  ["placesAtEventBulk", "the bulk sibling of a per-event check nothing batches yet; H-section item"],
  ["isSameSponsorName", "re-exported by lib/sponsor-merge.ts and called through neither path; H-section item"],

  // --- Venues: rows can be created and then never corrected -----------------
  ["assignVenueOwner", "no admin control on /dashboard/venue-owners/[id]; owner org is set at creation and never after"],
  ["updateVenue", "no edit form anywhere; a venue can be created and never corrected"],
  ["unlinkEventVenue", "the reversibility lib/venue-claim-actions.ts cites to justify its review bar"],

  // --- Safety and moderation: built, documented, never on screen ------------
  ["fencesOverlap", "the two-events-one-building warning; the geofence editor never asks for it"],
  ["getTrustSignal", "trust-not-exposed.test.ts says moderation reads this through the dashboard — no dashboard screen does"],
  ["contactInfoWarning", "the sentence shown above the composer; the chat route returns checkContactInfo's bare hint instead"],
  ["unmoderatedPhotos", "the read side of the photo audit recordPhotoCheck writes; no admin screen queries the backlog"],
  ["canSendSystemMessages", "named in CLAUDE.md as caller-less; kept as the written rule until something needs it"],
  ["canSendPushNotifications", "same — the rule exists, the caller does not"],

  // --- Notifications and real-time: the client contract outruns the server --
  ["emitChatReaction", "docs/SOCKET_EVENTS.md publishes chat:reaction to clients; nothing emits it, and there is no reaction write path to emit from"],

  // --- Half-wired flows ------------------------------------------------------
  ["isRoleAddressFor", "the domain-verification email fallback; only the DNS TXT path is wired"],
  ["domainVerifyEmail", "the template that fallback would send"],
  ["expertiseFor", "nothing serves the expertise options for a chosen work field"],
  ["formatAge", "the moderation queue has no age column, which is the SLA it formats"],
  ["cleanupExpiredTokens", "no cron sweeps mobile_refresh_tokens, so revoked and expired rows accumulate forever"],

  // --- Genuinely test-only, by design ---------------------------------------
  ["workFieldsMissingExpertise", "its own docblock says exported for the test rather than run at import"],
  ["resetSpamHistory", "test seam for module-level state; production never wants it"],
  ["clearAllSpamHistory", "same"],
  ["resetMemoryStore", "same, for the in-process rate-limit fallback"],
])

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue
      walk(full, out)
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full)
    }
  }
  return out
}

const callerFiles = [
  ...CALLER_DIRS.flatMap((d) => walk(join(ROOT, d))),
  ...CALLER_FILES.map((f) => join(ROOT, f)).filter(existsSync),
]

/** Comment-stripped, once. Every match below runs against these, never the raw file. */
const sources = new Map(callerFiles.map((f) => [f, stripComments(readFileSync(f, "utf8"))]))
const libFiles = callerFiles.filter((f) => f.startsWith(join(ROOT, "lib")))
const rel = (f: string) => f.slice(ROOT.length + 1)

/**
 * Exported *functions* only.
 *
 * Types are erased and constants are data — neither can be "called by nothing"
 * in the sense that matters, and listing them would drown the signal. An
 * `export const x = () => ...` is a function by any other name, so it counts.
 */
const EXPORTED_FUNCTION =
  /^export\s+(?:async\s+)?function\s+(\w+)|^export\s+const\s+(\w+)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]*)?=>/gm

interface Export {
  module: string
  name: string
}

const exports_: Export[] = libFiles.flatMap((file) =>
  [...sources.get(file)!.matchAll(EXPORTED_FUNCTION)].map((m) => ({
    module: file,
    name: m[1] ?? m[2],
  }))
)

/** Which other files name this export. */
function callersOf(exp: Export): string[] {
  const word = new RegExp(`\\b${exp.name}\\b`)
  return callerFiles.filter((f) => f !== exp.module && word.test(sources.get(f)!)).map(rel)
}

/**
 * Used by its own module, so the module's public entry point reaches it.
 *
 * `pointInPolygon` is exported so its unit test can pin the maths, and called
 * by `distanceToPolygon` two lines down. That is a file-internal helper, not
 * unreachable capability, and flagging it would add sixty lines of noise to
 * `KNOWN_UNREACHABLE` that teach a reader nothing.
 *
 * Deliberately shallow: it does not check that the *caller* is itself reachable,
 * so two dead exports propping each other up inside one file still pass. Closing
 * that needs real import resolution, and the ratchet is worth more than the
 * completeness.
 */
function usedInsideOwnModule(exp: Export): boolean {
  return (sources.get(exp.module)!.match(new RegExp(`\\b${exp.name}\\b`, "g")) ?? []).length > 1
}

const isReachable = (exp: Export) => callersOf(exp).length > 0 || usedInsideOwnModule(exp)

describe("lib exports are reachable", () => {
  it("found exports and callers to check, so this cannot pass vacuously", () => {
    expect(libFiles.length).toBeGreaterThan(80)
    expect(callerFiles.length).toBeGreaterThan(300)
    expect(exports_.length).toBeGreaterThan(300)
    // The root entrypoints, which are how every sweeper and initialiser is
    // reached. A path typo here would silently mark them all dead.
    expect(callerFiles).toContain(join(ROOT, "server.ts"))
  })

  it("every exported function has a caller", () => {
    const dead = exports_
      .filter((e) => !KNOWN_UNREACHABLE.has(e.name))
      .filter((e) => !isReachable(e))
      .map((e) => `${rel(e.module)} :: ${e.name}`)

    // Listed rather than counted, so a failure names what to wire up, delete,
    // or add to KNOWN_UNREACHABLE with a reason.
    expect(dead).toEqual([])
  })
})

describe("the unreachable list is current", () => {
  it.each([...KNOWN_UNREACHABLE])("%s — %s", (name) => {
    const exp = exports_.find((e) => e.name === name)
    // A renamed or deleted export leaves a line here that means nothing.
    expect(exp).toBeDefined()
    expect(isReachable(exp as Export)).toBe(false)
  })
})

/**
 * A `"use server"` file may only export async functions.
 *
 * `next build` enforces this — "can only export async functions, found object" —
 * and nothing else does. `lib/sponsor-actions.ts` carried a `const` array and a
 * re-exported sync function for several commits while `tsc`, `jest` and `eslint`
 * all passed; the branch simply could not be deployed, and the only way to find
 * out was a 40-second production build.
 *
 * Types are exempt: `export interface` and `export type` are erased before the
 * directive means anything.
 */
describe("use-server modules export only async functions", () => {
  const actionModules = libFiles
    .map((f) => [f, readFileSync(f, "utf8")] as const)
    .filter(([, src]) => src.trimStart().startsWith('"use server"'))

  const EXPORT =
    /^export\s+(?!async function|interface|type\s|\{[^}]*\}\s+from|default\s+async)(.+)$/gm

  it("finds the use-server modules at all", () => {
    expect(actionModules.length).toBeGreaterThan(8)
  })

  it.each(actionModules.map(([f, src]) => [rel(f), src]))("%s", (_label, src) => {
    const offenders = [...(src as string).matchAll(EXPORT)]
      .map((m) => m[0].split("\n")[0].trim())
      // A bare `export { x }` re-export is only safe if x is an async
      // function, which this cannot see — but it is also the shape that broke
      // the build, so it is not exempt.
      .filter((line) => !line.startsWith("export type") && !line.startsWith("export interface"))
    expect(offenders).toEqual([])
  })
})
