import { readFileSync } from "fs"
import { join } from "path"
import { EXPORT_CHECKLIST } from "@/scripts/export-user"

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
