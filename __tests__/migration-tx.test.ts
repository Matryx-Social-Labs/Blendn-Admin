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
    // Likewise `CREATE INDEX CONCURRENTLY`: Postgres refuses it inside a transaction, and one statement is atomic enough.
    if (statements.length === 1 && /^CREATE (UNIQUE )?INDEX CONCURRENTLY/i.test(statements[0])) return
    expect(statements[0].toUpperCase()).toBe("BEGIN")
    expect(statements.at(-1)!.toUpperCase()).toBe("COMMIT")
  })
})

describe("a CONCURRENTLY migration is exactly one statement", () => {
  // The allowance above must not become a way to run several statements outside a transaction.
  it("the unread-message index is a single CREATE INDEX CONCURRENTLY", () => {
    const sql = readFileSync(join(DIR, "20261022100200_private_messages_unread_idx", "migration.sql"), "utf8")
    const statements = sql.replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS "private_messages_unread_idx" ON "private_messages" \("conversation_id"\) WHERE "is_read" = false$/)
  })
})

describe("the inbox preview index", () => {
  it("is a single CREATE INDEX CONCURRENTLY", () => {
    const sql = readFileSync(join(DIR, "20261022150300_private_messages_preview_idx", "migration.sql"), "utf8")
    const statements = sql.replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS "private_messages_conversation_created_idx" ON "private_messages" \("conversation_id", "created_at" DESC, "id" DESC\)$/)
  })
})
