import { readdirSync, readFileSync } from "fs"
import { join } from "path"

/** Migrations from step 17 on run statement by statement under `prisma migrate deploy`: each is its own transaction or it can half-apply. */
const DIR = join(process.cwd(), "prisma", "migrations")
const FIRST_WRAPPED = "20261009120000"

describe("migrations are transactions", () => {
  const files = readdirSync(DIR).filter((d) => d >= FIRST_WRAPPED && /^\d{14}_/.test(d))
  it.each(files)("%s begins and commits", (dir) => {
    const sql = readFileSync(join(DIR, dir, "migration.sql"), "utf8")
    const statements = sql.replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)
    // One `ALTER TYPE … ADD VALUE` cannot share a transaction with its use, and is a single statement already.
    if (statements.length === 1 && /^ALTER TYPE .* ADD VALUE/i.test(statements[0])) return
    expect(statements[0].toUpperCase()).toBe("BEGIN")
    expect(statements.at(-1)!.toUpperCase()).toBe("COMMIT")
  })
})
