import { readFileSync, readdirSync, statSync } from "fs"
import { join, relative } from "path"

/**
 * Every audit row is written by lib/audit-log.ts (step 18 security review, M3).
 *
 * The row's organisation — which decides which organisation's log shows it —
 * is attributed there and only there (`ORG_RESOURCES`). A direct
 * `audit_logs.create` writes a row with no organisation: never a leak, since a
 * row with none is the platform's alone, but a hole in the organisation's own
 * history, and the billing, charge and webhook writers were all direct.
 * In-transaction writers use `auditInTx`; the rest `auditLog`.
 */
const ROOT = join(__dirname, "..")
const WRITER = "lib/audit-log.ts"
const DIRECT = /\baudit_logs\s*\.\s*(create|createMany|createManyAndReturn|upsert|update|updateMany)\s*\(/

function files(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) files(full, acc)
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full)
  }
  return acc
}

const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

describe("audit rows are written through lib/audit-log.ts", () => {
  const all = ["app", "lib", "scripts"].flatMap((d) => files(join(ROOT, d))).map((f) => relative(ROOT, f))

  it("walked the tree", () => {
    expect(all.length).toBeGreaterThan(300)
  })

  it("nothing else writes audit_logs", () => {
    const direct = all.filter((f) => f !== WRITER && DIRECT.test(code(join(ROOT, f))))
    expect(direct).toEqual([])
  })

  it("the writer is still the one that writes", () => {
    expect(DIRECT.test(code(join(ROOT, WRITER)))).toBe(true)
  })
})
