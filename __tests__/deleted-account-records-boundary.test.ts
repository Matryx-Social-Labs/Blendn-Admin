import { readFileSync, readdirSync } from "fs"
import { join, resolve } from "path"

/*
 * Nothing the product serves may read `deleted_account_records`.
 *
 * It holds the name, email, phone and birth date of people who asked to be
 * erased, kept only because the IT Rules 2021 (r.3(1)(h)) require 180 days of
 * it for a lawful request. That request is answered by an admin querying the
 * database, logged in `audit_logs` (docs/RETENTION.md) — never by a route, a
 * dashboard page, or a helper one could be wired to.
 *
 * One file may name it: the writer and purge. The deletion route calls that
 * module without naming the table, so `app/` stays clean too.
 */
const ROOT = resolve(__dirname, "..")
const TABLE = "deleted_account_records"
const ALLOWED = new Set(["lib/deleted-account-records.ts"])

function sourcesUnder(dir: string): string[] {
  return (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
    .filter((f) => /\.(ts|tsx|js|jsx)$/.test(f))
    .map((f) => join(dir, f))
}

describe("deleted_account_records is read by no route, page or helper", () => {
  const files = ["app", "components", "lib"].flatMap(sourcesUnder)

  it("scans the tree at all", () => {
    // Without this the assertion below passes vacuously if the walk breaks.
    expect(files).toContain("app/api/mobile/account/route.ts")
    expect(files).toContain("lib/deleted-account-records.ts")
  })

  it("is named only by its writer", () => {
    const naming = files.filter((f) => readFileSync(join(ROOT, f), "utf8").includes(TABLE))
    expect(naming.filter((f) => !ALLOWED.has(f))).toEqual([])
    // And the writer really does, so a rename cannot make this test blind.
    expect(naming).toEqual([...ALLOWED])
  })
})
