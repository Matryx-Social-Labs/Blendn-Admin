import { db, closeDb } from "./helpers"

afterAll(async () => {
  await closeDb()
})

/**
 * Postgres indexes the referenced side of a foreign key but never the
 * referencing side, so an unindexed FK column turns every cascade delete of a
 * parent into one sequential scan of the child table per parent row.
 *
 * `chat_messages.parent_id` shipped that way and made deleting a chat group
 * effectively non-terminating once the table had real volume. This asserts the
 * class of bug is gone rather than the one instance, so adding a model with an
 * unindexed relation fails here instead of in production.
 */
describe("every foreign key is indexed", () => {
  it("finds no single-column FK without a leading index", async () => {
    const unindexed = await db.$queryRaw<Array<{ tbl: string; col: string; refs: string }>>`
      SELECT c.conrelid::regclass::text AS tbl,
             a.attname                  AS col,
             c.confrelid::regclass::text AS refs
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f'
        AND array_length(c.conkey, 1) = 1
        -- An index whose FIRST column is the FK column serves the lookup; a
        -- composite index that merely contains it somewhere does not.
        AND NOT EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1]
        )
      ORDER BY 1, 2`

    const described = unindexed.map((r) => `${r.tbl}.${r.col} -> ${r.refs}`)
    expect(described).toEqual([])
  })
})
