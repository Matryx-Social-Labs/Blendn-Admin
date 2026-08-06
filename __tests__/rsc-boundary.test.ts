import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

/**
 * Server components may not hand functions to client components.
 *
 * This test exists because that rule was broken in production and nothing
 * caught it. `components/dashboard/data-table.tsx` gained a `"use client"`
 * directive in the table-system PR. Five call sites had been passing
 * `render` / `sortValue` / `rowHref` **functions** in their column definitions
 * since the original design rebuild, back when `DataTable` was a server
 * component and that was legal.
 *
 * Adding the directive turned all five illegal in one commit, and:
 *
 *   - `tsc` cannot see it — the prop types are satisfied, it is a runtime
 *     serialisation rule
 *   - `next build` cannot see it — every affected page is `force-dynamic`, so
 *     none of them render at build time
 *   - the test suite cannot see it — no test in this repo renders a route
 *
 * So the first thing that noticed was the production error log, with the
 * dashboard root showing "Something went wrong" to every signed-in admin.
 *
 * The rule enforced here is deliberately blunt: **anything importing a client
 * component that takes function props must itself be a client module.** A
 * server component could in principle render `DataTable` with function-free
 * columns, but no call site in this codebase does, and a rule with an escape
 * hatch would not have caught the original bug.
 */

const ROOT = join(__dirname, "..")

/**
 * Client components whose props include functions. Adding one here is how a
 * future component gets the same protection.
 */
const FUNCTION_PROP_CLIENT_COMPONENTS = [
  { module: "components/dashboard/data-table", specifier: "@/components/dashboard/data-table" },
]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx$/.test(full)) out.push(full)
  }
  return out
}

const sourceFiles = [join(ROOT, "app"), join(ROOT, "components")].flatMap((d) => walk(d))

function isClientModule(file: string): boolean {
  const head = readFileSync(file, "utf8").slice(0, 400)
  return /^\s*["']use client["']/.test(head)
}

describe("server/client boundary", () => {
  it("finds source files to check (guards against a broken walker)", () => {
    // A walker that silently returns [] would make every assertion below pass.
    expect(sourceFiles.length).toBeGreaterThan(20)
  })

  for (const target of FUNCTION_PROP_CLIENT_COMPONENTS) {
    it(`${target.module} is itself a client component`, () => {
      // The premise of the rule below. If this ever flips back to a server
      // component the rule is unnecessary and should be revisited, not deleted.
      expect(isClientModule(join(ROOT, `${target.module}.tsx`))).toBe(true)
    })

    it(`every importer of ${target.module} is a client module`, () => {
      const offenders = sourceFiles
        .filter((file) => file !== join(ROOT, `${target.module}.tsx`))
        .filter((file) => readFileSync(file, "utf8").includes(target.specifier))
        .filter((file) => !isClientModule(file))
        .map((file) => file.slice(ROOT.length + 1))

      // Named rather than counted, so the failure tells you what to fix.
      expect(offenders).toEqual([])
    })
  }
})
