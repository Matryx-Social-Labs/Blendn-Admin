/**
 * Which constraint did the database refuse on?
 *
 * ## Why this is not `error.message.includes(name)`
 *
 * That is the obvious way to write it, and in this stack it never matches.
 * Prisma's own message names the violated **fields**:
 *
 *     "Unique constraint failed on the fields: (`event_id`)"
 *
 * The constraint *name* is only in the driver adapter's nested cause:
 *
 *     meta.driverAdapterError.cause.originalMessage
 *       = 'duplicate key value violates unique constraint
 *          "event_claims_one_approved_per_event"'
 *
 * Two handlers were written the obvious way and neither ever fired. Filing a
 * duplicate claim answered "Could not file the claim" instead of naming the
 * claim already waiting, and losing an approval race threw raw instead of
 * saying somebody else's claim was approved first — a graceful path that had
 * been written, reviewed, and was unreachable.
 *
 * It matters most for **partial unique indexes**, which are exactly the ones a
 * handler wants to distinguish: `schema.prisma` cannot express them, so they
 * live in raw SQL, Prisma has no model-level knowledge of them, and the fields
 * it reports are shared with other indexes on the same table. The name is the
 * only thing that tells `event_claims_one_pending_per_org` from
 * `event_claims_one_approved_per_event`, and the name is the part the obvious
 * check cannot see.
 *
 * Matching against the serialised whole error is deliberately shape-agnostic.
 * The field has already moved once between two Prisma configurations of this
 * project, so a path into it is a thing that breaks silently.
 */
export function violatedConstraint(error: unknown, name: string): boolean {
  if (!error || typeof error !== "object") return false
  const code = (error as { code?: string }).code
  // P2002 unique, P2003 foreign key, P2000/P2004 check and the rest.
  if (typeof code !== "string" || !code.startsWith("P2")) return false
  const meta = (error as { meta?: unknown }).meta
  const message = error instanceof Error ? error.message : ""
  return `${message}${JSON.stringify(meta ?? "")}`.includes(name)
}
