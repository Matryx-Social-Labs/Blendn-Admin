import { readFileSync } from "fs"
import { join } from "path"
import { Client } from "pg"
import { cleanup, closeDb, makeUser } from "./helpers"

/*
 * SCRUM-1358: the app connects as `blendn_app`, a role that reads and writes rows and can do nothing else.
 *
 * The web process and `prisma migrate deploy` ran with the same owner (on Railway, superuser) credentials, so one slip
 * in a `$queryRawUnsafe` would run with the right to drop any table or `COPY … PROGRAM`. This suite acts as the role
 * through `SET ROLE` on a second connection (privileges are checked against `current_user`), so it never sets the
 * cluster-wide role's password. The `DATABASE_URL` connection, the superuser migrations run as in CI, is the negative
 * control: the same statements pass.
 */
const ROLE = "blendn_app"
const INSUFFICIENT_PRIVILEGE = "42501"
const MIGRATION = join(process.cwd(), "prisma", "migrations", "20261126190000_blendn_app_role", "migration.sql")

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  return client
}

/** The SQLSTATE a statement fails with, or "ok". Each runs in its own transaction, rolled back. */
async function attempt(client: Client, sql: string): Promise<string> {
  await client.query("BEGIN")
  try {
    await client.query(sql)
    return "ok"
  } catch (e) {
    return (e as { code?: string }).code ?? String(e)
  } finally {
    await client.query("ROLLBACK")
  }
}

const REFUSED = [
  "CREATE TABLE itest_app_role_x (id int)",
  "CREATE TEMP TABLE itest_app_role_t (id int)",
  "CREATE SCHEMA itest_app_role_s",
  "CREATE FUNCTION itest_app_role_f() RETURNS int LANGUAGE sql AS 'SELECT 1'",
  "CREATE EXTENSION pg_trgm",
  "DROP TABLE notifications",
  "ALTER TABLE notifications ADD COLUMN itest_x int",
  "ALTER TABLE notifications DISABLE TRIGGER ALL",
  "TRUNCATE notifications",
  "CREATE INDEX itest_app_role_idx ON notifications (title)",
  "COPY (SELECT 1) TO PROGRAM 'true'",
  "SELECT pg_read_file('/etc/hostname')",
]

let owner: Client
let app: Client
const users: string[] = []

beforeAll(async () => {
  owner = await connect()
  const { rowCount } = await owner.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [ROLE])
  if (!rowCount) throw new Error(`${ROLE} is missing: build the database with \`npm run db:migrate\`, not db:push`)
  app = await connect()
  await app.query(`SET ROLE ${ROLE}`)
})

afterAll(async () => {
  const quietly = (p: Promise<unknown> | undefined) => p?.catch(() => {})
  await quietly(app?.end())
  await quietly(owner?.query("DROP TABLE IF EXISTS itest_app_role_future"))
  await quietly(owner?.end())
  await cleanup(users, [])
  await closeDb()
})

describe("the app's database role", () => {
  it("can sign in and holds no superuser, create-role, create-db, replication or bypass-RLS right", async () => {
    const { rows } = await app.query(
      `SELECT current_user AS who, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
       FROM pg_roles WHERE rolname = current_user`,
    )
    expect(rows).toEqual([
      { who: ROLE, rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false },
    ])
  })

  it("is a member of no other role", async () => {
    const { rows } = await owner.query("SELECT roleid::regrole::text AS r FROM pg_auth_members WHERE member = $1::regrole", [ROLE])
    expect(rows).toEqual([])
  })

  it("inserts, reads, updates and deletes a row", async () => {
    const userId = await makeUser("approle")
    users.push(userId)
    const inserted = await app.query(
      "INSERT INTO notifications (id, user_id, kind, title, body) VALUES (gen_random_uuid(), $1, 'event_update', 't', 'b') RETURNING id",
      [userId],
    )
    const id = inserted.rows[0].id
    await app.query("UPDATE notifications SET read_at = now() WHERE id = $1", [id])
    const read = await app.query("SELECT read_at IS NOT NULL AS read FROM notifications WHERE id = $1", [id])
    expect(read.rows).toEqual([{ read: true }])
    const deleted = await app.query("DELETE FROM notifications WHERE id = $1", [id])
    expect(deleted.rowCount).toBe(1)
  })

  it("can read and write every table but the migration history, including those later migrations created", async () => {
    const { rows } = await owner.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> '_prisma_migrations'
         AND NOT (has_table_privilege($1, c.oid, 'SELECT') AND has_table_privilege($1, c.oid, 'INSERT')
              AND has_table_privilege($1, c.oid, 'UPDATE') AND has_table_privilege($1, c.oid, 'DELETE'))`,
      [ROLE],
    )
    expect(rows).toEqual([])
  })

  it.each(REFUSED)("is refused: %s", async (sql) => {
    expect(await attempt(app, sql)).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it("cannot read or edit the migration history", async () => {
    expect(await attempt(app, "SELECT count(*) FROM _prisma_migrations")).toBe(INSUFFICIENT_PRIVILEGE)
    expect(await attempt(app, "DELETE FROM _prisma_migrations")).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it("can read and write a table a later migration creates, its sequence too (default privileges)", async () => {
    await owner.query("CREATE TABLE itest_app_role_future (id serial PRIMARY KEY, v int)")
    await app.query("INSERT INTO itest_app_role_future (v) VALUES (7)")
    expect((await app.query("SELECT v FROM itest_app_role_future")).rows).toEqual([{ v: 7 }])
    expect(await attempt(app, "DROP TABLE itest_app_role_future")).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it("the migration runs again cleanly where the role already exists (another database, a rebuilt schema)", async () => {
    await owner.query(readFileSync(MIGRATION, "utf8"))
    expect(await attempt(app, "SELECT count(*) FROM notifications")).toBe("ok")
    expect(await attempt(app, "SELECT count(*) FROM _prisma_migrations")).toBe(INSUFFICIENT_PRIVILEGE)
  })

  // Negative control: the superuser migrations run as in CI can do every one of them, so each refusal is the role's.
  it.each(REFUSED)("the migrating superuser can: %s", async (sql) => {
    expect(await attempt(owner, sql)).toBe("ok")
  })
})
