import { readFileSync } from "fs"
import { join } from "path"
import { EXPORT_CHECKLIST, runRefusal } from "@/scripts/export-user"

/*
 * The export (scripts/export-user.ts) and the erasure (DELETE
 * /api/mobile/account) answer the same question: where is this person's data?
 * A table the erasure learns about and the export does not is data a person
 * asked for and was not given. Every table the route touches, through Prisma
 * or in raw SQL, must be on the export's checklist: exported, or "not
 * exported" with the reason.
 */
const route = readFileSync(join(__dirname, "..", "app/api/mobile/account/route.ts"), "utf8")

function erasureTables(source: string): string[] {
  const prisma = [...source.matchAll(/\bdb\.([a-zA-Z_]+)\./g)].map((m) => m[1])
  const raw = [...source.matchAll(/\b(?:FROM|UPDATE|INTO|JOIN)\s+([a-z_]+)/g)].map((m) => m[1])
  return [...new Set([...prisma, ...raw])].sort()
}

it("reads the erasure's tables from the route (the parser still sees it)", () => {
  const tables = erasureTables(route)
  expect(tables).toEqual(expect.arrayContaining(["user", "profiles", "event_check_ins", "private_conversations", "crew_members", "venue_offer_sends"]))
  expect(tables.length).toBeGreaterThan(30)
})

it.each(erasureTables(route))("the export's checklist covers %s", (table) => {
  expect(EXPORT_CHECKLIST).toHaveProperty([table])
})

describe("runRefusal: local databases only, unless the flag says otherwise", () => {
  const local = "postgresql://u:p@127.0.0.1:55433/blendn"
  const remote = "postgresql://u:p@db.railway.example:5432/railway"

  it("runs against this machine's database", () => {
    expect(runRefusal(local, ["asha@example.com"])).toBeNull()
  })

  it("refuses a remote database without --allow-remote, naming only the host", () => {
    const refusal = runRefusal(remote, ["asha@example.com"])
    expect(refusal).toMatch(/db\.railway\.example is not a local database/)
    expect(refusal).not.toContain("u:p")
  })

  it("runs against a remote database with --allow-remote", () => {
    expect(runRefusal(remote, ["asha@example.com", "--allow-remote"])).toBeNull()
  })

  it("refuses no target, an unknown flag, and no DATABASE_URL", () => {
    expect(runRefusal(local, [])).toMatch(/usage/)
    expect(runRefusal(local, ["asha@example.com", "--allow-remot"])).toMatch(/usage/)
    expect(runRefusal(undefined, ["asha@example.com"])).toMatch(/DATABASE_URL/)
  })
})
