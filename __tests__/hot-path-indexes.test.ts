import { readFileSync, readdirSync } from "fs"
import { join } from "path"

/*
 * The indexes the hottest predicates depend on.
 *
 * `fk-indexes.itest.ts` covers foreign keys against a real Postgres, which is
 * the right tool and only runs in CI. This is the cheaper half: it asserts the
 * datamodel still *declares* these, so a reverted or reformatted schema fails
 * on a plain `npm test` rather than at the next slow-query report.
 *
 * Each one serves a query that scanned. The live-ops pair matter most: that
 * tick runs twelve times a minute per watched event, and `lib/live-snapshot.ts`
 * claimed "the queries are all indexed and scoped to one event" while two of
 * them had no index to use.
 *
 * The schema and the migration are checked together, because they are two
 * statements of the same fact and drift between them is the failure that
 * `prisma migrate deploy` turns into a production incident.
 */
const ROOT = join(__dirname, "..")
const SCHEMA = () => readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8")

/** The body of one `model X { ... }` block. */
function model(name: string): string {
  const m = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, "m").exec(SCHEMA())
  if (!m) throw new Error(`model ${name} not found in schema.prisma`)
  return m[1]
}

/** Every line of SQL across every migration, concatenated. */
function allMigrations(): string {
  const dir = join(ROOT, "prisma", "migrations")
  return readdirSync(dir)
    .filter((d) => !d.startsWith("."))
    .map((d) => {
      try {
        return readFileSync(join(dir, d, "migration.sql"), "utf8")
      } catch {
        return ""
      }
    })
    .join("\n")
}

const REQUIRED: Array<{ model: string; index: string; sqlName: string; why: string }> = [
  {
    model: "event_check_ins",
    index: "@@index([event_id, check_in_time])",
    sqlName: "event_check_ins_event_id_check_in_time_idx",
    why: "the 5s live-ops tick counts arrivals and builds the histogram on this",
  },
  {
    model: "venues",
    index: "@@index([latitude, longitude])",
    sqlName: "venues_latitude_longitude_idx",
    why: "the Hotspots feed bounding-boxes on venue coordinates",
  },
  {
    model: "User",
    index: "@@index([createdAt])",
    sqlName: "User_createdAt_idx",
    why: "the admin overview reads User five times per load",
  },
  {
    model: "User",
    index: "@@index([role])",
    sqlName: "User_role_idx",
    why: "the host count filters on role",
  },
  {
    model: "profiles",
    index: "@@index([onboarded])",
    sqlName: "profiles_onboarded_idx",
    why: "the admin funnel semi-joins into profiles three times per load",
  },
]

describe("the datamodel declares the hot-path indexes", () => {
  for (const { model: m, index, why } of REQUIRED) {
    it(`${m} has ${index} — ${why}`, () => {
      expect(model(m).replace(/\s+/g, " ")).toContain(index.replace(/\s+/g, " "))
    })
  }
})

describe("a migration actually creates each one", () => {
  const sql = allMigrations()

  for (const { sqlName } of REQUIRED) {
    it(`creates ${sqlName}`, () => {
      /*
       * Declaring an index in schema.prisma and never writing the migration is
       * the drift that `prisma migrate deploy` cannot fix: the datamodel says
       * the index exists, the database disagrees, and nothing complains until a
       * query is slow.
       */
      expect(sql).toContain(sqlName)
    })
  }
})

describe("expression indexes stay out of the migration until drift is settled", () => {
  it("does not create a GIN or lower() index Prisma cannot represent", () => {
    /*
     * Both are real wins -- event full-text search currently computes a tsvector
     * per row twice per request, and the case-insensitive city lookups cannot
     * use their plain btree. But neither is expressible in schema.prisma, so
     * creating them would leave the database holding indexes the datamodel does
     * not know about, and `prisma db push` -- which this project uses for local
     * iteration -- would drop them.
     *
     * This test is a placeholder for the decision, not a permanent rule. When a
     * drift policy exists (R8's shared schema package is where it belongs),
     * delete this and add the indexes.
     */
    const mine = readFileSync(
      join(ROOT, "prisma", "migrations", "20260820200000_hot_path_indexes", "migration.sql"),
      "utf8"
    )
    expect(mine).not.toMatch(/USING\s+gin/i)
    expect(mine).not.toMatch(/CREATE INDEX[^;]*lower\s*\(/i)
  })
})
