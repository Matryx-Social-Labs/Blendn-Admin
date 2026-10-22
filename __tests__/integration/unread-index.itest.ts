/**
 * The badge count's partial index exists, is valid, and is partial (the
 * CONCURRENTLY migration, applied by `migrate deploy` as one statement). A
 * failed concurrent build leaves an INVALID index that `IF NOT EXISTS` would
 * skip, so validity is the thing to read.
 *
 * Not in negative-controls.json: it checks that a database exists in a state,
 * not a guard in code, so there is no source mutation that fails it other than
 * deleting the migration.
 */
import { closeDb, db } from "./helpers"

afterAll(closeDb)

it("private_messages_unread_idx is valid and covers only the unread rows", async () => {
  const rows = await db.$queryRaw<{ indisvalid: boolean; def: string }[]>`
    SELECT i.indisvalid, pg_get_indexdef(i.indexrelid) AS def
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'private_messages_unread_idx'`
  expect(rows).toHaveLength(1)
  expect(rows[0].indisvalid).toBe(true)
  expect(rows[0].def).toMatch(/\(conversation_id\)/)
  expect(rows[0].def).toMatch(/WHERE \(?"?is_read"? = false\)?/)
})
