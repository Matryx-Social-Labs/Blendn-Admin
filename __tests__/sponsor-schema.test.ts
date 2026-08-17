import { readFileSync, readdirSync } from "fs"
import { join } from "path"

/**
 * The sponsor schema's load-bearing constraints, asserted on the source.
 *
 * Five of these cannot be expressed in `schema.prisma` at all — they are
 * partial unique indexes and a CHECK, hand-written in the migration. Nothing in
 * the Prisma model file hints they exist, so the next person to regenerate a
 * migration from the schema would produce one without them and notice nothing:
 * every one fails open, silently, under concurrency or at the edges.
 *
 * The rest are model-level facts whose absence is equally quiet — a missing
 * composite FK does not error, it just stops validating.
 */

const ROOT = join(__dirname, "..")
const SCHEMA = () => readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8")

/** Every migration SQL file, concatenated. Order does not matter for presence. */
const MIGRATIONS = () => {
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

describe("enum values ship alone, before anything references them", () => {
  it("adds user_role.sponsor and message_type.poll with IF NOT EXISTS", () => {
    // ALTER TYPE ... ADD VALUE cannot be used in the same transaction that adds
    // it, and railway.json runs `prisma migrate deploy` as a preDeployCommand —
    // so a half-applied enum migration does not just fail, it stops the service
    // coming back. IF NOT EXISTS makes the statement safe to re-run.
    const sql = MIGRATIONS()
    expect(sql).toMatch(/ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'sponsor'/)
    expect(sql).toMatch(/ALTER TYPE "message_type" ADD VALUE IF NOT EXISTS 'poll'/)
  })
})

describe("constraints Prisma cannot express", () => {
  const sql = MIGRATIONS()

  it("allows only one APPROVED claim per brand", () => {
    // The model's @@unique([sponsor_id, org_id]) stops ONE org filing twice. It
    // does not stop two DIFFERENT orgs both reaching approved on the same
    // brand, which is ownership decided by whichever transaction commits last.
    expect(sql).toMatch(/CREATE UNIQUE INDEX[^;]*"sponsor_claims"[^;]*WHERE "status" = 'approved'/)
  })

  it("allows only one LIVE charge per placement, so voiding stays recoverable", () => {
    // A plain unique would make `void` terminal: no corrected charge could ever
    // be raised, which is the entire point of having the state.
    expect(sql).toMatch(/CREATE UNIQUE INDEX[^;]*"placement_charges"[^;]*WHERE "status" <> 'void'/)
  })

  it("allows only one live brand per normalised name per owning org", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX[^;]*"sponsors"[^;]*"org_id", "name_key"/)
  })

  it("refuses an active campaign with no sponsor", () => {
    // The due-select joins through sponsor_id. A null there does not error —
    // the row simply never matches, so the campaign silently never sends.
    expect(sql).toMatch(/CHECK \(NOT "is_active" OR "sponsor_id" IS NOT NULL\)/)
  })

  it("indexes the sweeper's real predicate, not an idealised one", () => {
    expect(sql).toMatch(/CREATE INDEX[^;]*"sponsored_due_idx"[^;]*WHERE "is_active"/)
  })
})

describe("model-level invariants that fail quietly when dropped", () => {
  const schema = SCHEMA()

  it("votes carry a COMPOSITE foreign key to (poll_id, option_id)", () => {
    // Without it, poll_id is an unvalidated free field: a row can claim poll A
    // while its option belongs to poll B, so the one-vote-per-poll unique
    // guards a fiction and the counts are wrong in a way no happy-path test
    // would find.
    expect(schema).toMatch(
      /@relation\(fields: \[poll_id, option_id\], references: \[poll_id, id\]/
    )
    // The redundant-looking unique on options is the FK's target. Deleting it
    // as "duplicate of the primary key" would break the constraint above.
    expect(schema).toMatch(/@@unique\(\[poll_id, id\]\)/)
  })

  it("never stores raw user ids on the send log", () => {
    // Raw ids would be a durable per-timestamp attendance roster joined to a
    // commercial entity. lib/pseudonym.ts solved this once already.
    expect(schema).toMatch(/recipient_hashes\s+String\[\]/)
    expect(schema).not.toMatch(/recipient_ids/)
  })

  it("keeps money off the row that decides whether an ad may run", () => {
    // A pricing correction must not rewrite an authorization fact.
    const placement = schema.slice(
      schema.indexOf("model event_sponsors {"),
      schema.indexOf("model sponsor_claims {")
    )
    expect(placement).not.toMatch(/amount_minor|currency|invoice_ref/)
  })

  it("does not store derived placement phases", () => {
    // `live` and `ended` come from the event's own timestamps. Storing them
    // needs a sweeper, and a late sweeper makes the database disagree with the
    // clock.
    const enumBlock = schema.slice(
      schema.indexOf("enum placement_status {"),
      schema.indexOf("}", schema.indexOf("enum placement_status {"))
    )
    expect(enumBlock).not.toMatch(/\blive\b|\bended\b/)
  })

  it("pins the charge author so the audit trail resolves", () => {
    // A bare String id pointing at a deleted user is an audit trail that cannot
    // be resolved.
    expect(schema).toMatch(/pricer\s+User\s+@relation\("ChargePricer"[^)]*onDelete: Restrict/)
  })
})
