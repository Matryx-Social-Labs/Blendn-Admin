import { readFileSync } from "fs"
import { join } from "path"

import { orgNameKeySql } from "@/lib/org-name-key"

/*
 * The pre-check in lib/org-name-key.ts and the unique index in the migration
 * must say the same thing, or the friendly answer and the real one disagree.
 * The itest proves the behaviour; this keeps the two spellings from drifting.
 */
it("the migration's organisation index uses the application's key expression", () => {
  const sql = readFileSync(join(__dirname, "..", "prisma", "migrations", "20261031000000_name_keys_unique", "migration.sql"), "utf8")
  expect(sql).toContain(orgNameKeySql("display_name"))
})
