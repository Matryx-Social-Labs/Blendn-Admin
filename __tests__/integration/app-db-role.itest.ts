import { randomBytes } from "crypto"
import { Client } from "pg"
import { cleanup, closeDb, makeUser } from "./helpers"

/*
 * SCRUM-1358: the app connects as `blendn_app`, a role that reads and writes rows and can do nothing else.
 *
 * The web process and `prisma migrate deploy` ran with the same owner (on Railway, superuser) credentials, so one slip
 * in a `$queryRawUnsafe` would run with the right to drop any table or `COPY … PROGRAM`. The migration creates the
 * role with no password (no secret in git); this suite gives it one, connects as it, and checks rows work and DDL does
 * not. The owner connection (`DATABASE_URL`, the role migrations run as) is the negative control: the same DDL passes.
 */
const ROLE = "blendn_app"
const INSUFFICIENT_PRIVILEGE = "42501"
const password = randomBytes(18).toString("hex")

function urlAs(user: string, pass: string): string {
  const url = new URL(process.env.DATABASE_URL!)
  url.username = user
  url.password = pass
  return url.toString()
}

async function connect(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString })
  await client.connect()
  return client
}

/** The SQLSTATE a statement fails with, or "ok". Each runs in its own transaction, rolled back. */
async function attempt(client: Client, sql: string, params: unknown[] = []): Promise<string> {
  await client.query("BEGIN")
  try {
    await client.query(sql, params)
    return "ok"
  } catch (e) {
    return (e as { code?: string }).code ?? String(e)
  } finally {
    await client.query("ROLLBACK")
  }
}

const DDL = [
  "CREATE TABLE itest_app_role_x (id int)",
  "DROP TABLE notifications",
  "ALTER TABLE notifications ADD COLUMN itest_x int",
  "TRUNCATE notifications",
  "CREATE INDEX itest_app_role_idx ON notifications (title)",
]

let owner: Client
let app: Client
const users: string[] = []

beforeAll(async () => {
  owner = await connect(process.env.DATABASE_URL!)
  // The password exists only for this run; the migration leaves the role without one.
  await owner.query(`ALTER ROLE ${ROLE} WITH PASSWORD '${password}'`)
  app = await connect(urlAs(ROLE, password))
})

afterAll(async () => {
  await app?.end()
  await owner?.query(`ALTER ROLE ${ROLE} WITH PASSWORD NULL`)
  await owner?.query("DROP TABLE IF EXISTS itest_app_role_future")
  await owner?.end()
  await cleanup(users, [])
  await closeDb()
})

describe("the app's database role", () => {
  it("is blendn_app and holds no superuser, create-role or create-db right", async () => {
    const { rows } = await app.query(
      "SELECT current_user AS who, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    )
    expect(rows).toEqual([{ who: ROLE, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false }])
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

  it.each(DDL)("is refused DDL: %s", async (sql) => {
    expect(await attempt(app, sql)).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it("cannot read or edit the migration history", async () => {
    expect(await attempt(app, "SELECT count(*) FROM _prisma_migrations")).toBe(INSUFFICIENT_PRIVILEGE)
    expect(await attempt(app, "DELETE FROM _prisma_migrations")).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it("can read and write a table a later migration creates (default privileges)", async () => {
    await owner.query("CREATE TABLE itest_app_role_future (id int)")
    await app.query("INSERT INTO itest_app_role_future VALUES (1)")
    expect((await app.query("SELECT id FROM itest_app_role_future")).rows).toEqual([{ id: 1 }])
    expect(await attempt(app, "DROP TABLE itest_app_role_future")).toBe(INSUFFICIENT_PRIVILEGE)
  })

  // Negative control: the role migrations run as can still do every one of them.
  it.each(DDL)("the owner role can: %s", async (sql) => {
    expect(await attempt(owner, sql)).toBe("ok")
  })
})
