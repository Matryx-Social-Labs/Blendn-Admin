import { db, closeDb } from "./helpers"

/**
 * A DM thread is read newest-first and "first unread" by conversation and time.
 * With `(conversation_id)` alone the history read the whole thread and sorted
 * it; the first-unread fell to the `(created_at)` index and walked other
 * people's messages. The index that serves both, in order, must be the one the
 * migrations build — a `db push` database gets it from the schema, so this
 * checks the migrated one.
 */
afterAll(closeDb)

it("private_messages is indexed by (conversation_id, created_at)", async () => {
  const rows = await db.$queryRaw<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes WHERE tablename = 'private_messages'`
  const defs = rows.map((r) => r.indexdef)
  expect(defs.some((d) => d.includes("(conversation_id, created_at)"))).toBe(true)
})
