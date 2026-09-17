import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

import { stripComments } from "./support/strip-comments"

/**
 * Every read of a person's organisation memberships is scoped to live
 * organisations.
 *
 * Suspending an organisation used to change a badge and nothing else
 * (SCRUM-8). The review of the fix found that "filter `actorFor`" was not
 * "every door": nine readers of `organisation_members` bypassed it — the
 * attendee CSV export, ⌘K search, event creation's owning org, venue
 * management, claim filing, the staff check-in kind — so a suspended venue
 * owner would have kept exports and invites after the permission resolver
 * refused them. One fragment, `activeMembership`, is spread into all of them;
 * this is what stops the tenth reader forgetting it.
 *
 * Blunt on purpose: any `organisation_members.find*` whose `where` names a
 * `user_id` must carry `activeMembership` in the same call. Reads keyed by
 * `org_id` alone ("who is in this org") are a different question and pass.
 */
const ROOT = join(__dirname, "..")

/** The fragment's home, and the reads that are not "which orgs may I act for". */
const ALLOWED = new Set([
  "lib/org-membership.ts",
  // "Are they already a member of THIS org" idempotency checks on the way in;
  // both routes refuse a suspended org by its status a few lines earlier.
  "app/api/organisation/accept-invite/route.ts",
  "app/api/organisation/join-request/route.ts",
])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|itest|spec)\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

const sources = [...walk(join(ROOT, "lib")), ...walk(join(ROOT, "app")), ...walk(join(ROOT, "components"))]

function offendersIn(file: string): number[] {
  const code = stripComments(readFileSync(file, "utf8"))
  const out: number[] = []
  const re = /organisation_members\s*\.\s*(findMany|findFirst|findUnique|count)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    // The call's argument: from the paren to its matching close.
    let depth = 0
    let i = m.index + m[0].length - 1
    for (; i < code.length; i++) {
      if (code[i] === "(") depth++
      else if (code[i] === ")" && --depth === 0) break
    }
    const call = code.slice(m.index, i + 1)
    // `getMyOrgs` is the documented exception: it lists suspended orgs so the
    // org page can say why. It says so in a comment the stripper removed, so
    // it is matched by its shape — the only user-keyed read that also selects
    // `suspension_reason`.
    // `user_id: true` is a select, not a filter.
    if (/user_id\s*:(?!\s*true\b)/.test(call) && !/activeMembership/.test(call) && !/suspension_reason/.test(call)) {
      out.push(code.slice(0, m.index).split("\n").length)
    }
  }
  return out
}

describe("membership reads", () => {
  it("are found (the guard has something to guard)", () => {
    const withReads = sources.filter((p) => /organisation_members\s*\.\s*find/.test(readFileSync(p, "utf8")))
    expect(withReads.length).toBeGreaterThan(8)
  })

  it("every user-keyed read outside lib/org-membership.ts spreads activeMembership", () => {
    const offenders = sources
      .filter((p) => !ALLOWED.has(p.replace(ROOT + "/", "")))
      .flatMap((p) => offendersIn(p).map((line) => `${p.replace(ROOT + "/", "")}:${line}`))
    expect(offenders).toEqual([])
  })
})
