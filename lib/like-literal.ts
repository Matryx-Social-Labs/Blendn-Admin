/**
 * `value` as a literal for Prisma's `{ equals: value, mode: "insensitive" }`.
 *
 * On Postgres that filter is ILIKE, so `_` and `%` in the value are wildcards:
 * renaming an amenity to "Open_Deck" was refused because "Open Deck" existed
 * (SCRUM-468). Backslash is ILIKE's default escape character, so it is escaped
 * too.
 */
export function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&")
}
