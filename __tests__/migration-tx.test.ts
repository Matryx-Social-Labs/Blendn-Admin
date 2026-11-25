import { readdirSync, readFileSync } from "fs"
import { join } from "path"

/** Migrations from step 17 on run statement by statement under `prisma migrate deploy`: each is its own transaction or it can half-apply. */
const DIR = join(process.cwd(), "prisma", "migrations")
const FIRST_WRAPPED = "20261009120000"
/**
 * Alone in its file and unwrapped: `ALTER TYPE … ADD VALUE` cannot share a transaction with its use, and
 * Postgres refuses `CONCURRENTLY` inside one. A single statement is atomic enough.
 */
const UNWRAPPABLE = /^(ALTER TYPE .* ADD VALUE|(CREATE|DROP) (UNIQUE )?INDEX CONCURRENTLY)/i
const statementsOf = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)

describe("migrations are transactions", () => {
  const files = readdirSync(DIR).filter((d) => d >= FIRST_WRAPPED && /^\d{14}_/.test(d))
  it.each(files)("%s begins and commits", (dir) => {
    const sql = readFileSync(join(DIR, dir, "migration.sql"), "utf8")
    const statements = statementsOf(sql)
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
    const statements = statementsOf(sql)
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS "private_messages_unread_idx" ON "private_messages" \("conversation_id"\) WHERE "is_read" = false$/)
  })
})

describe("the inbox preview index", () => {
  it("is a single CREATE INDEX CONCURRENTLY", () => {
    const sql = readFileSync(join(DIR, "20261022150300_private_messages_preview_idx", "migration.sql"), "utf8")
    const statements = statementsOf(sql)
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

/**
 * Drops and renames the previous build may still read. A constraint, index, default, NOT NULL or trigger
 * changes no shape it reads, and a temp table's `ON COMMIT DROP` outlives nothing. A NOT NULL column
 * with no default fails every insert the previous build makes.
 */
const CONTRACTS = [
  /(?<!\bCOMMIT\s+)\bDROP\s+(?!(CONSTRAINT|INDEX|DEFAULT|NOT\s+NULL|TRIGGER)\b)/i,
  /\bRENAME\b/i,
  /\bADD\s+COLUMN\b(?![\s\S]*\bDEFAULT\b)[\s\S]*\bNOT\s+NULL\b/i,
]
/** Locks held for as long as the table takes to scan, rewrite or index. Read per ALTER TABLE clause. */
const LOCKS = [
  /\bCREATE\s+(UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY\b)/i,
  /\bADD\s+(CONSTRAINT\s+\S+\s+)?(CHECK|FOREIGN\s+KEY)\b(?![\s\S]*\bNOT\s+VALID\b)/i,
  /\bADD\s+(CONSTRAINT\s+\S+\s+)?(UNIQUE|PRIMARY\s+KEY|EXCLUDE)\b(?!\s+USING\s+INDEX\b)/i,
  /\bADD\s+COLUMN\b[\s\S]*\b(REFERENCES|CHECK|GENERATED|DEFAULT\s+(gen_random_uuid|uuid_generate_v4|random|clock_timestamp|nextval)\s*\()/i,
  /\bSET\s+NOT\s+NULL\b/i,
  /\bALTER\s+(COLUMN\s+)?\S+\s+(SET\s+DATA\s+)?TYPE\b/i,
]
const CLAUSE = /,\s*(?=(?:ADD|ALTER|DROP|RENAME|VALIDATE|SET|ENABLE|DISABLE)\b)/i
const NAME = String.raw`(?:"?\w+"?\.)?"?(\w+)"?`
const CREATED = new RegExp(String.raw`^CREATE\s+(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?` + NAME, "i")
const TARGET = new RegExp(String.raw`^(?:ALTER\s+TABLE(?:\s+IF\s+EXISTS)?(?:\s+ONLY)?|CREATE\s+(?:UNIQUE\s+)?INDEX\b[\s\S]*?\bON(?:\s+ONLY)?)\s+` + NAME, "i")

function migrationViolations(sql: string): string[] {
  const statements = statementsOf(sql)
  const created = new Set<string>()
  const contractOk = /^\s*--\s*contract:.*#\d+/m.test(sql)
  const lockOk = /^\s*--\s*lock-ok:\s*\S/m.test(sql)
  const out: string[] = []
  for (const s of statements) {
    const shown = s.replace(/\s+/g, " ")
    const made = CREATED.exec(s)?.[1]
    if (made) created.add(made)
    const target = TARGET.exec(s)?.[1]
    if (target && created.has(target)) continue // nobody else can see the table until COMMIT
    const clauses = s.split(CLAUSE)
    if (!contractOk && CONTRACTS.some((re) => clauses.some((c) => re.test(c)))) out.push(`contract: ${shown}`)
    if (!lockOk && LOCKS.some((re) => clauses.some((c) => re.test(c)))) out.push(`lock: ${shown}`)
  }
  // VALIDATE scans without blocking writes only in a transaction of its own.
  if (!lockOk && statements.some((s) => /\bNOT\s+VALID\b/i.test(s)) && statements.some((s) => /\bVALIDATE\s+CONSTRAINT\b/i.test(s))) {
    out.push("lock: NOT VALID and VALIDATE CONSTRAINT in one transaction")
  }
  if (statements[0]?.toUpperCase() === "BEGIN" && !/^SET\s+LOCAL\s+lock_timeout\s*(=|TO)\s*'?[1-9]/i.test(statements[1] ?? "")) {
    out.push("lock_timeout: not the second statement")
  }
  return out
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
    `DROP TRIGGER IF EXISTS "t" ON "x";`,
    `CREATE TEMP TABLE "t" ON COMMIT DROP AS SELECT "id" FROM "x";`,
  ])("allows %s", (stmt) => {
    expect(migrationViolations(wrap(stmt))).toEqual([])
  })
  it("ignores DROP and RENAME in comments", () => {
    expect(migrationViolations(wrap(`-- we may DROP COLUMN "y" or RENAME it later\n/* DROP TABLE "x"; */\nALTER TABLE "x" ADD COLUMN "z" TEXT;`))).toEqual([])
  })
  it("reads lower-case SQL", () => {
    expect(migrationViolations(`begin;\nset local lock_timeout = '5s';\nalter table "x" drop column "y";\ncreate index "i" on "x"("y");\ncommit;`)).toHaveLength(2)
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
    `ALTER TABLE "x" ADD CHECK ("y" > 0);`,
    `ALTER TABLE "x" ADD FOREIGN KEY ("y") REFERENCES "z"("id");`,
    `ALTER TABLE "x" ADD UNIQUE ("y");`,
    `ALTER TABLE "x" ADD COLUMN "y" UUID REFERENCES "z"("id");`,
    `ALTER TABLE "x" ADD COLUMN "y" UUID DEFAULT gen_random_uuid();`,
    `ALTER TABLE "x" ADD COLUMN "y" INT GENERATED ALWAYS AS ("z" + 1) STORED;`,
    `ALTER TABLE "x" ADD CONSTRAINT "a" CHECK ("y" > 0), ADD CONSTRAINT "b" CHECK ("y" < 9) NOT VALID;`,
    `ALTER TABLE "x" ADD CONSTRAINT "a" CHECK ("y" > 0) NOT VALID;\nALTER TABLE "x" VALIDATE CONSTRAINT "a";`,
  ])("refuses %s on an existing table without lock-ok", (stmt) => {
    expect(migrationViolations(wrap(stmt))).toHaveLength(1)
    expect(migrationViolations(`-- lock-ok: x has 40 rows\n` + wrap(stmt))).toEqual([])
  })
  it.each([
    `ALTER TABLE "x" ADD CONSTRAINT "x_y_check" CHECK ("y" > 0) NOT VALID;`,
    `ALTER TABLE "x" ADD CONSTRAINT "x_y_fkey" FOREIGN KEY ("y") REFERENCES "z"("id") NOT VALID;`,
    `ALTER TABLE "x" VALIDATE CONSTRAINT "x_y_check";`,
    `ALTER TABLE "x" ADD CONSTRAINT "x_y_key" UNIQUE USING INDEX "x_y_key";`,
    `ALTER TABLE "x" ADD COLUMN "y" TIMESTAMPTZ NOT NULL DEFAULT now(), ADD COLUMN "z" TEXT NOT NULL DEFAULT 'a, b';`,
  ])("allows %s", (stmt) => {
    expect(migrationViolations(wrap(stmt))).toEqual([])
  })
  it("refuses a NOT NULL column with no default, which the previous build's inserts leave out", () => {
    expect(migrationViolations(wrap(`ALTER TABLE "x" ADD COLUMN "y" TEXT NOT NULL;`))).toEqual([`contract: ALTER TABLE "x" ADD COLUMN "y" TEXT NOT NULL`])
  })
  it("allows the locking statements on a table the same file creates", () => {
    const body = `CREATE TABLE IF NOT EXISTS "public"."x" ("id" UUID NOT NULL, "y" UUID);
CREATE INDEX "x_y_idx" ON ONLY "public"."x"("y");
ALTER TABLE "x" ADD COLUMN "z" TEXT NOT NULL;
ALTER TABLE "x" ADD CONSTRAINT "x_y_fkey" FOREIGN KEY ("y") REFERENCES "z"("id") ON DELETE CASCADE;
ALTER TABLE "x" ALTER COLUMN "y" SET NOT NULL;`
    expect(migrationViolations(wrap(body))).toEqual([])
  })
  it("does not let a created table excuse another", () => {
    expect(migrationViolations(wrap(`CREATE TABLE "a" ("id" UUID);\nCREATE INDEX "b_y_idx" ON "b"("y");`))).toHaveLength(1)
  })
  it("does not excuse what comes before the CREATE TABLE", () => {
    expect(migrationViolations(wrap(`ALTER TABLE "x" RENAME TO "old_x";\nCREATE TABLE "x" ("id" UUID);`))).toHaveLength(1)
  })
  it("does not let contract excuse a lock", () => {
    expect(migrationViolations(`-- contract: gone since #12\n` + wrap(`CREATE INDEX "x_y_idx" ON "x"("y");`))).toHaveLength(1)
  })
  it("does not let lock-ok excuse a DROP COLUMN", () => {
    expect(migrationViolations(`-- lock-ok: small\n` + wrap(`ALTER TABLE "x" DROP COLUMN "y";`))).toHaveLength(1)
  })
  it("allows a single CONCURRENTLY statement, which cannot be wrapped", () => {
    expect(migrationViolations(`CREATE INDEX CONCURRENTLY "x_y_idx" ON "x"("y");`)).toEqual([])
    expect(migrationViolations(`DROP INDEX CONCURRENTLY IF EXISTS "x_y_idx";`)).toEqual([])
  })

  it.each([
    `BEGIN;\nALTER TABLE "x" ADD COLUMN "y" TEXT;\nCOMMIT;`,
    `BEGIN;\nALTER TABLE "x" ADD COLUMN "y" TEXT;\nSET LOCAL lock_timeout = '5s';\nCOMMIT;`,
    `BEGIN;\nSET LOCAL lock_timeout = 0;\nALTER TABLE "x" ADD COLUMN "y" TEXT;\nCOMMIT;`,
    `BEGIN;\nSET LOCAL lock_timeout TO '0';\nCREATE TABLE "x" ("id" UUID);\nCOMMIT;`,
    `BEGIN;\nUPDATE "x" SET "y" = 1;\nCOMMIT;`,
  ])("wants a non-zero SET LOCAL lock_timeout second in every wrapped migration: %s", (sql) => {
    expect(migrationViolations(sql)).toEqual(["lock_timeout: not the second statement"])
  })
  it("takes lock_timeout as = or TO", () => {
    expect(migrationViolations(`BEGIN;\nSET LOCAL lock_timeout TO '5s';\nUPDATE "x" SET "y" = 1;\nCOMMIT;`)).toEqual([])
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
