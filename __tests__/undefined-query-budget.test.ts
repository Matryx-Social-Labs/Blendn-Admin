import { readFileSync, readdirSync } from "fs"
import { join, sep } from "path"

/**
 * The explicit-`undefined` budget, and why it may only shrink.
 *
 * **Progress: `app/api/events/[id]/route.ts` is done — 33 sites to 0**, which
 * was half the original 68. Converted to conditional spreads, one judgement
 * per site, with the operator chosen per field: `!= null` where the original
 * used `??` (so `0`, `false` and `""` survive), truthiness only where the
 * original used it, and `!== undefined` for `min_age`, the one field an
 * explicit null must be able to clear.
 *
 * ## The hazard, which is a runtime one
 *
 * Prisma *strips* `undefined` keys from a where-clause rather than matching
 * nothing. So `chat_group_id: event.chat_group?.id` silently became an
 * unscoped `{ id: flagId }` lookup and reopened a cross-org moderation hole
 * that had already been fixed once. `strictUndefinedChecks` is the only
 * mechanical guard against that class, and it is the class this whole audit is
 * about: a query that quietly widens.
 *
 * ## Why the flag is not simply switched on
 *
 * Measured on Prisma 7.9.1: enabling it produces **zero** typecheck errors and
 * a green unit suite, because it is a *runtime* check and every DB-touching
 * unit test mocks `@/lib/db`. It would look completely safe and be broken in
 * production.
 *
 * The blocker is that 68 call sites across 19 files pass an explicit
 * `undefined` as the idiomatic "leave this field alone" - `field: value ??
 * undefined`. Under the flag each of those throws instead. Every one needs
 * reading to decide whether it means "do not touch this column" (make it a
 * conditional spread) or is a genuine no-op (delete it). That is judgement per
 * site, not a codemod, and doing it carelessly is how the hole reopens.
 *
 * ## So this is a ratchet, not a fix
 *
 * It records today's count per file and fails if any grows, or if a new file
 * appears. The migration stays finite instead of receding, and nobody has to
 * hold the whole thing in their head to make progress: fix one file, lower one
 * number.
 *
 * The count is an over-estimate, deliberately. The regex sees any
 * `: undefined` in `app/` or `lib/`, including local sentinels that never
 * reach Prisma. That is the right way for a ratchet to be wrong: it can only
 * make the remaining work look larger than it is, never smaller.
 *
 * When every count reaches zero, enable `strictUndefinedChecks` and delete
 * this file. Tracked as the J1 half of SCRUM-52's territory.
 */

const ROOT = join(__dirname, "..")

/**
 * Sites per file, measured 2026-08-26. **This list may shrink and must never
 * grow.** A number that goes up means a new unscoped-query hazard was added.
 */
const BUDGET: Record<string, number> = {
  "app/api/events/[id]/chat/members/[userId]/route.ts": 4,
  "app/api/events/route.ts": 8,
  "app/api/mobile/events/[eventId]/announce/route.ts": 1,
  "app/api/mobile/events/[eventId]/clone/route.ts": 3,
  "app/api/mobile/events/[eventId]/route.ts": 2,
  "app/api/mobile/message-requests/[requestId]/respond/route.ts": 1,
  "app/api/mobile/profiles/[userId]/route.ts": 3,
  "app/api/mobile/users/[userId]/favorites/route.ts": 2,
  "app/api/onboarding/apply/route.ts": 1,
  "lib/account-actions.ts": 1,
  "lib/audit-log.ts": 1,
  "lib/pagination.ts": 1,
  "lib/poll-actions.ts": 1,
  "lib/presence.ts": 1,
  "lib/room-delivery.ts": 1,
  "lib/services/events.service.ts": 1,
  "lib/socket-server.ts": 1,
  "lib/upload-grant-actions.ts": 2,
}

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) tsFiles(full, acc)
    else if (entry.name.endsWith(".ts")) acc.push(full)
  }
  return acc
}

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

function countIn(src: string): number {
  const clean = strip(src)
  return (
    (clean.match(/:\s*\w[\w.?]*\s*\?\?\s*undefined/g) ?? []).length +
    (clean.match(/:\s*undefined\b/g) ?? []).length
  )
}

describe("explicit undefined in queries only ever decreases", () => {
  const measured: Record<string, number> = {}
  for (const dir of ["app", "lib"]) {
    for (const file of tsFiles(join(ROOT, dir))) {
      const rel = file.slice(ROOT.length + 1).split(sep).join("/")
      const n = countIn(readFileSync(file, "utf8"))
      if (n > 0) measured[rel] = n
    }
  }

  it("finds the call sites at all", () => {
    // Guards the counter. If the regex stops matching, every assertion below
    // passes vacuously while reporting progress that did not happen - which is
    // the exact failure R16's recorded controls exist to catch.
    expect(Object.keys(measured).length).toBeGreaterThan(0)
  })

  it("has no file above its budget, and no new file", () => {
    const regressions: string[] = []
    for (const [file, n] of Object.entries(measured)) {
      const allowed = BUDGET[file]
      if (allowed === undefined) regressions.push(`${file}: NEW, ${n} sites`)
      else if (n > allowed) regressions.push(`${file}: ${n} sites, budget ${allowed}`)
    }

    // The shape carries the hint: jest's `expect` takes one argument, and the
    // message-as-second-argument is a Playwright idiom that throws here.
    expect({
      regressions,
      hint:
        regressions.length > 0
          ? "Prisma strips undefined from a where-clause rather than matching nothing, so this " +
            "is how a scoped query silently becomes unscoped. Use a conditional spread."
          : "",
    }).toEqual({ regressions: [], hint: "" })
  })

  it("keeps the budget honest by failing on a stale entry", () => {
    /*
     * The half that makes a ratchet a ratchet. Without it the budget becomes an
     * allowlist: somebody fixes a file, the entry stays, and the number is free
     * to climb back to it unnoticed.
     */
    const stale = Object.entries(BUDGET)
      .filter(([file, n]) => (measured[file] ?? 0) < n)
      .map(([file, n]) => `${file}: budget ${n}, actually ${measured[file] ?? 0} - lower it`)

    expect({ stale }).toEqual({ stale: [] })
  })
})
