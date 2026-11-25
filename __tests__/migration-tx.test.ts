import { readdirSync, readFileSync } from "fs"
import { join } from "path"

/** Migrations from step 17 on run statement by statement under `prisma migrate deploy`: each is its own transaction or it can half-apply. */
const DIR = join(process.cwd(), "prisma", "migrations")
const FIRST_WRAPPED = "20261009120000"
/**
 * Alone in its file and unwrapped: `ALTER TYPE … ADD VALUE` cannot share a transaction with its use, and
 * Postgres refuses `CONCURRENTLY` inside one. A single statement is atomic enough.
 */
const UNWRAPPABLE = /^(ALTER TYPE .* ADD VALUE|CREATE (UNIQUE )?INDEX CONCURRENTLY)/i

describe("migrations are transactions", () => {
  const files = readdirSync(DIR).filter((d) => d >= FIRST_WRAPPED && /^\d{14}_/.test(d))
  it.each(files)("%s begins and commits", (dir) => {
    const sql = readFileSync(join(DIR, dir, "migration.sql"), "utf8")
    const statements = sql.replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)
    if (statements.length === 1 && UNWRAPPABLE.test(statements[0])) return
    expect(statements[0].toUpperCase()).toBe("BEGIN")
    expect(statements.at(-1)!.toUpperCase()).toBe("COMMIT")
  })
})

describe("UNWRAPPABLE", () => {
  it.each([`ALTER TYPE "kind" ADD VALUE 'x'`, `CREATE INDEX CONCURRENTLY "x_idx" ON "x"("y")`, `DROP INDEX CONCURRENTLY IF EXISTS "x_idx"`])("lets %s stand alone", (stmt) => {
    expect(UNWRAPPABLE.test(stmt)).toBe(true)
  })
  it("does not let a plain index build skip the transaction", () => {
    expect(UNWRAPPABLE.test(`CREATE INDEX "x_idx" ON "x"("y")`)).toBe(false)
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

/**
 * From here on a migration must not break the build it replaces (DEPLOYMENT.md, "A migration is
 * additive for one release"). Railway runs `migrate deploy` while the old container still serves,
 * and a rollback redeploys the old build onto the new schema. History is left as it is.
 */
const LAST_UNCHECKED = "20261125120000"

function migrationViolations(sql: string): string[] {
  return []
}

describe("migrationViolations", () => {
  const wrap = (body: string) => `BEGIN;\nSET LOCAL lock_timeout = '5s';\n${body}\nCOMMIT;\n`

  it("refuses an unmarked DROP COLUMN", () => {
    expect(migrationViolations(wrap(`ALTER TABLE "x" DROP COLUMN "y";`))).toEqual([`contract: ALTER TABLE "x" DROP COLUMN "y"`])
  })
  it("passes the same DROP COLUMN marked with the release that stopped reading it", () => {
    expect(migrationViolations(`-- contract: nothing reads "y" since #1234\n` + wrap(`ALTER TABLE "x" DROP COLUMN "y";`))).toEqual([])
  })
  it("wants a PR number in the contract marker", () => {
    expect(migrationViolations(`-- contract: unused\n` + wrap(`ALTER TABLE "x" DROP COLUMN "y";`))).toHaveLength(1)
  })
  it.each([
    `DROP TABLE "x";`,
    `ALTER TABLE "x" DROP "y";`,
    `ALTER TABLE "x" DROP IF EXISTS "y";`,
    `DROP TYPE "kind";`,
    `ALTER TABLE "x" RENAME COLUMN "a" TO "b";`,
    `ALTER TABLE "x" RENAME "a" TO "b";`,
    `ALTER TABLE "x" RENAME TO "z";`,
    `ALTER TABLE "x" RENAME CONSTRAINT "a" TO "b";`,
    `ALTER TYPE "kind" RENAME VALUE 'a' TO 'b';`,
  ])("refuses an unmarked %s", (stmt) => {
    expect(migrationViolations(wrap(stmt))).toHaveLength(1)
  })
  it.each([
    `DROP INDEX "x_idx";`,
    `DROP INDEX IF EXISTS "x_idx";`,
    `ALTER TABLE "x" DROP CONSTRAINT "x_check";`,
    `ALTER TABLE "x" ALTER COLUMN "y" DROP DEFAULT;`,
    `ALTER TABLE "x" ALTER COLUMN "y" DROP NOT NULL;`,
    `ALTER TABLE "x" ADD COLUMN "y" TEXT;`,
    `UPDATE "x" SET "y" = 'dropped' WHERE "y" IS NULL;`,
  ])("allows %s", (stmt) => {
    expect(migrationViolations(wrap(stmt))).toEqual([])
  })
  it("ignores DROP and RENAME in comments", () => {
    expect(migrationViolations(wrap(`-- we may DROP COLUMN "y" or RENAME it later\nALTER TABLE "x" ADD COLUMN "z" TEXT;`))).toEqual([])
  })

  it.each([
    `CREATE INDEX "x_y_idx" ON "x"("y");`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "x_y_key" ON "public"."x" ("y");`,
    `ALTER TABLE "x" ADD CONSTRAINT "x_y_check"\n  CHECK ("y" > 0);`,
    `ALTER TABLE "x" ADD CONSTRAINT "x_y_fkey" FOREIGN KEY ("y") REFERENCES "z"("id");`,
    `ALTER TABLE "x" ADD CONSTRAINT "x_y_key" UNIQUE ("y");`,
    `ALTER TABLE "x" ALTER COLUMN "y" SET NOT NULL;`,
    `ALTER TABLE "x" ALTER COLUMN "y" TYPE BIGINT;`,
    `ALTER TABLE "x" ALTER COLUMN "y" SET DATA TYPE TEXT;`,
  ])("refuses %s on an existing table without lock-ok", (stmt) => {
    expect(migrationViolations(wrap(stmt))).toHaveLength(1)
    expect(migrationViolations(`-- lock-ok: x has 40 rows\n` + wrap(stmt))).toEqual([])
  })
  it.each([
    `ALTER TABLE "x" ADD CONSTRAINT "x_y_check" CHECK ("y" > 0) NOT VALID;`,
    `ALTER TABLE "x" ADD CONSTRAINT "x_y_fkey" FOREIGN KEY ("y") REFERENCES "z"("id") NOT VALID;`,
    `ALTER TABLE "x" VALIDATE CONSTRAINT "x_y_check";`,
    `ALTER TABLE "x" ADD CONSTRAINT "x_y_key" UNIQUE USING INDEX "x_y_key";`,
  ])("allows %s", (stmt) => {
    expect(migrationViolations(wrap(stmt))).toEqual([])
  })
  it("allows the locking statements on a table the same file creates", () => {
    const body = `CREATE TABLE "x" ("id" UUID NOT NULL, "y" UUID);
CREATE INDEX "x_y_idx" ON "x"("y");
ALTER TABLE "x" ADD CONSTRAINT "x_y_fkey" FOREIGN KEY ("y") REFERENCES "z"("id") ON DELETE CASCADE;
ALTER TABLE "x" ALTER COLUMN "y" SET NOT NULL;`
    expect(migrationViolations(wrap(body))).toEqual([])
  })
  it("does not let lock-ok excuse a DROP COLUMN", () => {
    expect(migrationViolations(`-- lock-ok: small\n` + wrap(`ALTER TABLE "x" DROP COLUMN "y";`))).toHaveLength(1)
  })
  it("allows a single CONCURRENTLY statement, which cannot be wrapped", () => {
    expect(migrationViolations(`CREATE INDEX CONCURRENTLY "x_y_idx" ON "x"("y");`)).toEqual([])
    expect(migrationViolations(`DROP INDEX CONCURRENTLY IF EXISTS "x_y_idx";`)).toEqual([])
  })

  it("wants SET LOCAL lock_timeout second in a wrapped migration with DDL", () => {
    expect(migrationViolations(`BEGIN;\nALTER TABLE "x" ADD COLUMN "y" TEXT;\nCOMMIT;`)).toEqual(["lock_timeout: not the second statement"])
    expect(migrationViolations(`BEGIN;\nALTER TABLE "x" ADD COLUMN "y" TEXT;\nSET LOCAL lock_timeout = '5s';\nCOMMIT;`)).toHaveLength(1)
  })
  it("does not want lock_timeout in a data-only migration", () => {
    expect(migrationViolations(`BEGIN;\nUPDATE "x" SET "y" = 1;\nCOMMIT;`)).toEqual([])
  })
})

describe("migrations after the cutoff are additive and do not hold long locks", () => {
  it("every migration after the cutoff passes migrationViolations", () => {
    const found = readdirSync(DIR)
      .filter((d) => /^\d{14}_/.test(d) && d.slice(0, 14) > LAST_UNCHECKED)
      .map((d) => [d, migrationViolations(readFileSync(join(DIR, d, "migration.sql"), "utf8"))] as const)
      .filter(([, v]) => v.length > 0)
    expect(found).toEqual([])
  })
})
