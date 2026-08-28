import { readFileSync, readdirSync } from "fs"
import { join, sep } from "path"

/**
 * Explicit `undefined` inside a Prisma call: the count is zero, and this holds
 * it there.
 *
 * ## The hazard
 *
 * Prisma *strips* an `undefined` value rather than matching or writing
 * nothing. So `chat_group_id: event.chat_group?.id` silently became an
 * unscoped `{ id: flagId }` lookup and reopened a cross-org moderation hole
 * that had already been fixed once. A query that quietly widens is the class
 * this whole audit is about, and `strictUndefinedChecks` is the only
 * mechanical guard against it.
 *
 * ## What happened to the "68 sites"
 *
 * That number was wrong, and it is worth recording how rather than quietly
 * restating it. The first version of this ratchet counted every `: undefined`
 * in `app/` and `lib/`, and most of what it found could not widen a query at
 * all: `nextCursor` on a paginated *return* value, a `userImage` on a socket
 * payload, `email: isSelf ? ... : undefined` on a response object, half a dozen
 * local variables. Converting those would have been churn dressed as progress,
 * and worse, it made the budget look like work remaining when it was not.
 *
 * Scoped to the argument of a brace-matched `db.<model>.<method>(...)` or
 * `tx.<model>.<method>(...)` call, the real figure was **48** — all now
 * converted to conditional spreads, one judgement per site, with the operator
 * chosen per field: `!= null` where the original used `??` (so `0`, `false` and
 * `""` survive), and `!== undefined` for the fields an explicit null must be
 * able to clear.
 *
 * The `tx.` half is not decoration. There are 73 transaction call sites in this
 * tree, and scoping to `db.` alone would have reported "3 sites left" while
 * ignoring every query inside a transaction — which is exactly where a silently
 * widened query does the most damage.
 *
 * ## Why this file is now subordinate to the flag
 *
 * `strictUndefinedChecks` is **on** (see `prisma/schema.prisma`), and it is
 * strictly stronger than anything here, because a static scan cannot see a
 * *variable* that happens to be `undefined` at runtime.
 *
 * That is not hypothetical. `app/api/mobile/events/[eventId]/checkin/route.ts`
 * wrote `device_info: deviceInfo` into an upsert, where `deviceInfo` is an
 * optional field of the request schema and is therefore `undefined` whenever a
 * client omits it. The source line is indistinguishable from every other field;
 * no regex over this tree would ever have flagged it. It was caught by turning
 * the flag on and running the integration suite against real Postgres, and it
 * failed seven tests the moment it was.
 *
 * So this guard's remaining job is narrow and cheap: catch the *literal* form
 * early, at unit-test time, before somebody has to execute the path to find
 * out. The third assertion below — that the flag is still enabled — is the one
 * that actually matters.
 */

const ROOT = join(__dirname, "..")

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

/**
 * The argument of a Prisma call, brace-matched.
 *
 * Brace-matched, not a negated character class: four guards in this repo have
 * been vacuous for using `[^}]*` or `[^)]*` to cross a delimiter, and every one
 * was caught by running its recorded control rather than by reading it.
 */
function prismaCallBodies(src: string): string[] {
  const bodies: string[] = []
  for (const m of src.matchAll(/\b(?:db|tx)\.\w+\.\w+\s*\(/g)) {
    let depth = 0
    for (let i = m.index! + m[0].length - 1; i < src.length; i++) {
      if (src[i] === "(") depth++
      else if (src[i] === ")") {
        depth--
        if (depth === 0) {
          bodies.push(src.slice(m.index!, i + 1))
          break
        }
      }
    }
  }
  return bodies
}

function countIn(src: string): number {
  const clean = strip(src)
  return prismaCallBodies(clean).reduce(
    (n, body) =>
      n +
      (body.match(/:\s*\w[\w.?]*\s*\?\?\s*undefined/g) ?? []).length +
      (body.match(/:\s*undefined\b/g) ?? []).length,
    0
  )
}

describe("no explicit undefined reaches a Prisma call", () => {
  const measured: Record<string, number> = {}
  for (const dir of ["app", "lib"]) {
    for (const file of tsFiles(join(ROOT, dir))) {
      const rel = file.slice(ROOT.length + 1).split(sep).join("/")
      const n = countIn(readFileSync(file, "utf8"))
      if (n > 0) measured[rel] = n
    }
  }

  it("still counts a hazard when it sees one", () => {
    /*
     * The control, and it has to be a fixture now.
     *
     * While the tree had sites left, "did we find any?" was the guard against a
     * regex that had quietly stopped matching. At zero that question inverts:
     * finding nothing is the pass condition, so a broken counter and a clean
     * tree are indistinguishable — the exact vacuity R16's recorded controls
     * exist to catch, arriving through success rather than through a bad regex.
     *
     * So the counter is exercised against known-bad input instead, covering all
     * three shapes it must see: the `??` idiom, a bare literal, and one inside a
     * transaction.
     */
    const hazards = `
      await db.events.findFirst({ where: { id: maybeId ?? undefined } })
      await db.profiles.update({ where: { id }, data: { bio: undefined } })
      await tx.event_check_ins.create({ data: { device_info: info ?? undefined } })
    `
    expect(countIn(hazards)).toBe(3)

    // And that it is not simply matching everything it is shown.
    expect(countIn(`const x = { id: undefined }; await fetch(url)`)).toBe(0)
  })

  it("finds none in the tree", () => {
    // The shape carries the hint: jest's `expect` takes one argument, and the
    // message-as-second-argument is a Playwright idiom that throws here.
    expect({
      sites: measured,
      hint:
        Object.keys(measured).length > 0
          ? "Prisma strips undefined rather than matching or writing nothing, so this is how a " +
            "scoped query silently becomes unscoped. Use a conditional spread: " +
            "...(value != null && { field: value })."
          : "",
    }).toEqual({ sites: {}, hint: "" })
  })

  it("keeps strictUndefinedChecks enabled, which is the guard that matters", () => {
    /*
     * The assertion with the most weight in this file.
     *
     * Everything above is a static scan, and a static scan cannot see
     * `device_info: deviceInfo` where the variable is optional — the real bug
     * this work found. Only the runtime flag can. If somebody drops the preview
     * feature to silence an error, every conversion above becomes decoration
     * and the class reopens silently, which is precisely how it reopened the
     * first time.
     */
    const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8")
    const generator = schema.slice(schema.indexOf("generator client"))
    const block = generator.slice(0, generator.indexOf("}") + 1)

    expect({
      enabled: /previewFeatures\s*=\s*\[[^\]]*"strictUndefinedChecks"/.test(block),
      hint: "",
    }).toEqual({
      enabled: true,
      hint: "",
    })
  })
})
