import { db } from "@/lib/db"
import { Refusal } from "@/lib/refusal"
import { violatedConstraint } from "@/lib/prisma-errors"

/**
 * An organisation's name key (SCRUM-956): the name as one person would read it,
 * so "Nightshift  Collective", "NIGHTSHIFT COLLECTIVE", a full-width "Ｎightshift"
 * and one with a zero-width space in it are one name. NFKC, format characters
 * and zero-width characters out, whitespace collapsed, lower-cased.
 *
 * It is SQL because the unique index is an expression index on the same text
 * (migration 20261031000000_name_keys_unique), so the database is the judge and
 * a check-then-write race cannot get past it. Keep the two identical.
 * ponytail: homoglyphs from another script (Cyrillic "а" for "a") are not
 * folded; that needs a confusables table, which is a separate decision.
 */
export const orgNameKeySql = (operand: string) =>
  `lower(btrim(regexp_replace(regexp_replace(normalize(${operand}, NFKC), '[\\u00AD\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF]', '', 'g'), '\\s+', ' ', 'g')))`

export const ORG_NAME_KEY_INDEX = "organisations_name_key_uniq"

export function orgNameTakenRefusal(name: string) {
  return new Refusal(
    `An organisation called “${name}” already exists. Ask the applicant for a name that tells them apart.`
  )
}

/** The friendly pre-check; the index is what actually holds the line. */
export async function orgNameTaken(name: string): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM organisations WHERE ${orgNameKeySql("display_name")} = ${orgNameKeySql("$1::text")} LIMIT 1`,
    name
  )
  return rows.length > 0
}

/** Turn a lost race on the index into the same answer the pre-check gives. */
export function refuseIfOrgNameTaken(error: unknown, name: string): never {
  if (violatedConstraint(error, ORG_NAME_KEY_INDEX)) throw orgNameTakenRefusal(name)
  throw error
}
