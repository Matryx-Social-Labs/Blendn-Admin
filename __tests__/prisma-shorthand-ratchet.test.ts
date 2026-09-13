import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

/**
 * Bare shorthand inside a Prisma `data:` block, ratcheted.
 *
 * `{ field }` passes `undefined` when the variable is absent, and under
 * `strictUndefinedChecks` that is a runtime error rather than "leave the column
 * alone". It has taken out a core flow **five** times:
 *
 * | | |
 * |---|---|
 * | #328 | `mobile_refresh_tokens.device_info` — sessions died at 15 minutes |
 * | #329 | the `profiles` upsert — onboarding could not be completed |
 * | #330 | signup — nobody could create an account |
 * | #332 | event create — no organiser could publish anything |
 * | #336 | event update (upsert) — no organiser could edit anything |
 *
 * Every one was invisible to `tsc`, because the columns really are optional,
 * and invisible to the unit suite, because it mocks `@/lib/db`.
 *
 * ## Why a ratchet and not a sweep
 *
 * Most of the 41 below are fine: a required field is not going to arrive
 * undefined. Converting all of them blind would be a large diff that reviewers
 * cannot check and that buys nothing for the safe ones. What actually costs
 * outages is the **next** one being added, and twice now the bug was a
 * conversion that was started and left half done — POST /api/events had five
 * fields converted and eleven not, under a comment saying the block was
 * converted.
 *
 * So: this list may **shrink** and must never **grow**. A new entry fails the
 * build and the author decides then, with the field in front of them, whether
 * it can be undefined.
 *
 * ## What counts
 *
 * Comments are stripped first, so a field named in prose is not a hit — the
 * mistake `event-notifications-reachable.test.ts` was written to avoid. Only
 * literal `data: {` blocks are scanned, brace-matched; a bare `create:`
 * elsewhere is an ordinary literal.
 *
 * ## What this does NOT see, which is how the sixth one got through
 *
 * This file used to claim `data: {` "is the object every Prisma write takes".
 * **That is false.** A write may assemble its object in a variable first —
 * `const updateData = {...}; db.user.update({ data: updateData })` — and then
 * nothing inside it is scanned at all.
 *
 * `app/dashboard/users/actions.ts` did exactly that, and its `profile.upsert`
 * update branch passed `interests: data.profile.interests` where the only
 * caller never sends `interests`. **Every admin edit of any user returned
 * 500.** Found by pressing Save Changes on the staging dashboard, not by any
 * test — this one included.
 *
 * So the second guard below enumerates the writes that build their object
 * indirectly. It is a list of five, each checked by hand; a new one fails the
 * build and the author decides then whether the object is safe. That is a
 * smaller and sharper instrument than widening the scan to every member
 * expression, which measured **220 hits across 50 files** and would have been
 * noise a reviewer learns to skip.
 *
 * ## Two more it did not see, 2026-09-12
 *
 * **The baseline grandfathered a live outage.** `report/route.ts -> description`
 * was in the list below as "fine" from the day it was taken; `description` is
 * `z.string().optional()` and the app never sends it, so no message report
 * from the phone had ever been written. A baseline taken blind is a list of
 * things to read, not a list of things that are safe.
 *
 * **A one-line `data: { a, b, c }` was invisible.** The line regex wanted the
 * shorthand on its own line, so `peer-ratings/route.ts`'s single-line create
 * with a bare optional `note` was never counted — and every rating without a
 * note 500'd. The scan now looks inside the block regardless of layout, with
 * `...( … )` conditional spreads dropped first so the converted form is not
 * counted as the hazard it replaced. The eight files that surfaced were each
 * read: every one is a required or computed value.
 */
const ROOT = join(__dirname, "..")

/**
 * Every bare shorthand in a Prisma `data:` block as of 2026-09-10.
 *
 * Shrink it by converting a field to `...(x !== undefined && { x })` and
 * deleting the entry. Do not add to it.
 */
const BASELINE: Record<string, string[]> = {
  "app/api/events/[id]/announcements/route.ts": ["content"],
  "app/api/events/[id]/chat/moderation/[flagId]/route.ts": ["action"],
  "app/api/events/[id]/chat/moderation/route.ts": ["limit", "page", "total"],
  "app/api/events/[id]/sponsored-messages/route.ts": ["content", "interval_minutes", "sponsor_id"],
  "app/api/events/route.ts": ["description", "timezone", "title"],
  "app/api/mobile/auth/signup/route.ts": ["email", "name"],
  "app/api/mobile/chat/groups/[chatGroupId]/messages/[messageId]/reactions/route.ts": ["emoji"],
  "app/api/mobile/chat/groups/[chatGroupId]/messages/route.ts": ["content", "type"],
  "app/api/mobile/events/[eventId]/chat/route.ts": ["anonymous_name", "content", "type"],
  "app/api/mobile/events/[eventId]/checkin/route.ts": ["anonymous_name"],
  // `rating` is required by the schema and `issue` is defaulted in the
  // destructure; `note`, the optional one, is a conditional spread.
  "app/api/mobile/events/[eventId]/peer-ratings/route.ts": ["issue", "rating"],
  "app/api/mobile/message-requests/route.ts": ["message"],
  "app/api/mobile/messages/[messageId]/report/route.ts": ["reason"],
  "app/api/onboarding/apply/route.ts": ["kind", "tier"],
  "app/dashboard/events/[id]/feedback/actions.ts": ["category", "sentiment"],
  "app/dashboard/events/curate/actions.ts": ["geofence"],
  "app/dashboard/users/actions.ts": ["role"],
  "lib/admin-role-actions.ts": ["email", "name", "role", "status"],
  "lib/amenity-actions.ts": ["name"],
  "lib/category-actions.ts": ["slug"],
  "lib/charge-actions.ts": ["currency"],
  "lib/event-claim-actions.ts": ["flags"],
  "lib/mobile-auth.ts": ["email", "provider"],
  "lib/onboarding-actions.ts": ["domain", "status"],
  "lib/org-actions.ts": ["domain", "role"],
  "lib/poll-actions.ts": ["kind", "label", "position", "question"],
  "lib/push-notifications.ts": ["title"],
  "lib/sponsor-actions.ts": ["name", "name_key"],
  "lib/sponsored-scheduler.ts": ["failures", "type"],
  "lib/upload-grant-actions.ts": ["key"],
  "lib/venue-actions.ts": ["name"],
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
}

/** The brace-matched body of the object starting at `start`. */
function braceBlock(src: string, start: number, open = "{", close = "}"): string {
  let depth = 1
  let i = start
  while (i < src.length && depth > 0) {
    if (src[i] === open) depth++
    else if (src[i] === close) depth--
    i++
  }
  return src.slice(start, i)
}

/**
 * Drop every `...( … )` — the conditional-spread form a hazard is converted
 * into — so `...(note !== undefined && { note })` does not read as a bare
 * `note`. Paren-matched, not a negated character class: the guard rule from
 * R16 applies to this scanner as much as to any other.
 */
function withoutConditionalSpreads(block: string): string {
  let out = ""
  let i = 0
  for (;;) {
    const j = block.indexOf("...(", i)
    if (j < 0) return out + block.slice(i)
    out += block.slice(i, j)
    const inner = braceBlock(block, j + 4, "(", ")")
    i = j + 4 + inner.length
  }
}

function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue
      const abs = join(dir, entry)
      if (statSync(abs).isDirectory()) walk(abs)
      else if (/\.tsx?$/.test(entry)) out.push(abs)
    }
  }
  walk(join(ROOT, "app"))
  walk(join(ROOT, "lib"))
  return out
}

function scan(): Record<string, string[]> {
  const found: Record<string, string[]> = {}
  for (const abs of sourceFiles()) {
    const rel = abs.slice(ROOT.length + 1).split(/[\\/]/).join("/")
    const src = stripComments(readFileSync(abs, "utf8"))
    const names = new Set<string>()
    for (const m of src.matchAll(/\bdata\s*:\s*\{/g)) {
      const block = withoutConditionalSpreads(braceBlock(src, (m.index ?? 0) + m[0].length))
      // A bare identifier bounded by `{`/`,` before and `,`/`}` after, on its
      // own line or inline — `x: y,` is not matched, `y` follows a colon.
      for (const s of block.matchAll(/(?:^|[{,])\s*([a-z_][a-z0-9_]*)\s*(?=[,}])/gm)) names.add(s[1])
    }
    if (names.size) found[rel] = [...names].sort()
  }
  return found
}

describe("bare shorthand in a Prisma data block", () => {
  const found = scan()

  it("finds the known ones, so the ratchet is not scanning nothing", () => {
    /*
     * If the scan broke — a renamed pattern, a bad regex — an empty result
     * would make "nothing new was added" pass trivially, which is the failure
     * mode this whole file exists to prevent in the product.
     */
    expect(Object.keys(found).length).toBeGreaterThan(10)
  })

  it("has not grown", () => {
    const added: string[] = []
    for (const [file, fields] of Object.entries(found)) {
      const known = BASELINE[file] ?? []
      for (const f of fields) if (!known.includes(f)) added.push(`${file} -> ${f}`)
    }
    expect(added).toEqual([])
  })

  it("has no stale entries, so shrinking is deliberate", () => {
    /*
     * Checked in both directions on purpose. A baseline nobody prunes becomes
     * an allowlist, and #269's ratchet already proved that a stale entry is the
     * thing that goes unnoticed.
     */
    const stale: string[] = []
    for (const [file, fields] of Object.entries(BASELINE)) {
      const now = found[file] ?? []
      for (const f of fields) if (!now.includes(f)) stale.push(`${file} -> ${f}`)
    }
    expect(stale).toEqual([])
  })
})

/**
 * Prisma writes whose `data:` is a variable, so the scan above cannot see them.
 *
 * Each was read by hand on 2026-09-10 and the reason it is safe is recorded.
 * The value here is not the audit — it is that a **new** entry fails the build,
 * because a variable-built `data` object is exactly where the sixth outage hid.
 */
const INDIRECT_DATA: Record<string, string> = {
  "app/api/mobile/profiles/[userId]/route.ts":
    "userUpdate — every field behind an explicit `!== undefined` guard",
  "app/dashboard/moderation/reports/actions.ts":
    "reviewed — three concrete values, no optional source",
  "app/dashboard/users/actions.ts":
    "updateData — the sixth outage lived here; interests is now a conditional spread",
  "lib/mobile-auth.ts":
    "unproven — a boolean picking between two literal blocks, both concrete",
  "lib/product-events.ts":
    "batch — a typed array of rows, built by recordProductEvent",
}

/**
 * `data: <identifier>` on a Prisma call.
 *
 * Deliberately narrow: `lib/openapi/**` and `lib/api-response.ts` also write
 * `data:` and neither is Prisma, so they are excluded by path rather than by
 * trying to prove call sites from text.
 */
function scanIndirect(): Record<string, string[]> {
  const found: Record<string, string[]> = {}
  for (const abs of sourceFiles()) {
    const rel = abs.slice(ROOT.length + 1).split(/[\\/]/).join("/")
    if (rel.startsWith("lib/openapi/") || rel === "lib/api-response.ts") continue
    const src = stripComments(readFileSync(abs, "utf8"))
    const names = new Set<string>()
    for (const line of src.split("\n")) {
      // `const { data: session } = useSession()` is a destructuring rename.
      if (/\b(?:const|let|var)\s*\{/.test(line)) continue
      /*
       * The leading class excludes `(data: LiveSnapshot)` — a parameter's type
       * annotation, not a write. `data: true` is a select, not a write either.
       */
      for (const [, , name] of line.matchAll(
        /(^|[^(\w$])data:\s*([A-Za-z_$][\w$]*)\s*(?=[,})]|$)/g
      )) {
        if (name === "true" || name === "false") continue
        names.add(name)
      }
    }
    if (names.size) found[rel] = [...names].sort()
  }
  return found
}

describe("Prisma writes that build their data object in a variable", () => {
  const found = scanIndirect()

  it("finds the known ones, so this guard is not scanning nothing", () => {
    expect(Object.keys(found).length).toBeGreaterThan(2)
  })

  it("has not grown", () => {
    /*
     * A new file here is not automatically a bug — it is a write this file's
     * main scan is structurally blind to, which is the state the sixth outage
     * shipped in. Read the object, then add it to `INDIRECT_DATA` with why it
     * is safe, or inline the literal so the scan above covers it.
     */
    const added = Object.keys(found).filter((f) => !(f in INDIRECT_DATA))
    expect(added).toEqual([])
  })

  it("has no stale entries", () => {
    const stale = Object.keys(INDIRECT_DATA).filter((f) => !(f in found))
    expect(stale).toEqual([])
  })
})
