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

/*
 * The erasure also runs through helpers. Every module the route imports is
 * listed with the tables it erases or rewrites for this person, so a new
 * import fails here until somebody has looked at it.
 */
const ROUTE_HELPERS: Record<string, string[]> = {
  "@/lib/ticket-holds": ["ticket_orders", "ticket_order_lines"],
  "@/lib/crews/sweep": ["crews", "crew_members"],
  "@/lib/deleted-account-records": ["deleted_account_records"],
  "@/lib/entitlements": ["entitlements"],
  "@/lib/checkout": ["event_check_ins", "presence_sessions", "chat_group_members"],
  "@/lib/audit-log": ["audit_logs"],
  // Storage, other people's rows (the waitlist moves), or reads only:
  "@/lib/retained-media": [],
  "@/lib/waitlist": [],
  "@/lib/logger": [],
  "@/lib/deletion-reauth": [],
  "@/lib/db": [],
  "@/lib/mobile-auth": [],
  "@/lib/account-blocklist": [],
  "@/lib/socket-server": [],
  "@/lib/room-close": [],
  "@/lib/env": [],
  "@/lib/revenuecat-api": [],
  "@/lib/rate-limit": [],
  "@/lib/tigris": [],
  "@/lib/api-response": [],
  "@/lib/api-input": [],
  "@/lib/apple-revoke": [],
}

function erasureTables(source: string): string[] {
  const prisma = [...source.matchAll(/\b(?:db|tx|prisma)\.([a-zA-Z_]+)\./g)].map((m) => m[1])
  const raw = [...source.matchAll(/\b(?:FROM|(?<!FOR )UPDATE|INTO|JOIN)\s+(?:public\.)?"?([A-Za-z_]+)/g)].map((m) => m[1].toLowerCase())
  return [...new Set([...prisma, ...raw, ...Object.values(ROUTE_HELPERS).flat()])].sort()
}

it("reads the erasure's tables from the route (the parser still sees it)", () => {
  const tables = erasureTables(route)
  expect(tables).toEqual(expect.arrayContaining(["user", "profiles", "event_check_ins", "private_conversations", "crew_members", "venue_offer_sends"]))
  expect(tables.length).toBeGreaterThan(30)
})

it("knows every module the erasure route imports", () => {
  const imported = [...route.matchAll(/from "(@\/lib\/[^"]+)"/g)].map((m) => m[1])
  expect([...new Set(imported)].sort()).toEqual(Object.keys(ROUTE_HELPERS).sort())
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

  it("refuses a local URL whose ?host= points elsewhere (pg connects to the last one)", () => {
    expect(runRefusal(`${local}?host=db.railway.example`, ["asha@example.com"])).toMatch(/db\.railway\.example is not a local/)
    expect(runRefusal(`${local}?host=127.0.0.1&host=db.railway.example`, ["asha@example.com"])).toMatch(/not a local/)
    expect(runRefusal(`${local}?host=localhost`, ["asha@example.com"])).toBeNull()
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
