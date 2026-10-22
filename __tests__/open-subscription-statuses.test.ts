import { readdirSync, readFileSync } from "fs"
import { join } from "path"

jest.mock("@/lib/db", () => ({ db: {} }))

import { OPEN_SUBSCRIPTION_STATUSES } from "@/lib/billing"

/**
 * "Open" is said twice: `OPEN_SUBSCRIPTION_STATUSES` (what the actions, the
 * Plan page and the webhook's conflict check read) and the partial unique
 * indexes that hold one open subscription per organisation and per venue
 * (migration SQL). If they drifted, the code would let a second mandate past
 * the check and the index would turn it into a 500 — or the index would let
 * one past that the code calls closed (step 17 review: pin the list).
 *
 * The latest definition of each index wins, as `migrate deploy` applies them.
 */
const MIGRATIONS = join(__dirname, "..", "prisma", "migrations")

function latestIndexStatuses(index: string): string[] {
  let found: string[] | null = null
  for (const dir of readdirSync(MIGRATIONS).sort()) {
    if (dir.endsWith(".toml")) continue
    const sql = readFileSync(join(MIGRATIONS, dir, "migration.sql"), "utf8")
    const at = sql.indexOf(`CREATE UNIQUE INDEX "${index}"`)
    if (at === -1) continue
    const statement = sql.slice(at, sql.indexOf(";", at))
    const list = statement.match(/status"?\s+IN\s*\(([^)]*)\)/i)?.[1]
    if (!list) throw new Error(`${dir}: ${index} has no status list`)
    found = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  }
  if (!found) throw new Error(`${index} is defined in no migration`)
  return found
}

describe("the open subscription statuses match the indexes", () => {
  it.each(["billing_checkouts_one_open_subscription_per_org", "billing_checkouts_one_open_subscription_per_venue"])(
    "%s lists exactly OPEN_SUBSCRIPTION_STATUSES",
    (index) => {
      expect(latestIndexStatuses(index).sort()).toEqual([...OPEN_SUBSCRIPTION_STATUSES].sort())
    }
  )
})
