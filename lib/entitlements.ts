import type {
  entitlement_product,
  entitlement_source,
  entitlement_subject,
  Prisma,
} from "@prisma/client"

import { db } from "./db"

/**
 * Who may use what was paid for (plan v2 §9.2). The one module that reads or
 * writes `entitlements`; `__tests__/entitlements-boundary.test.ts` fails the
 * build on any other.
 *
 * Every paid surface asks `hasEntitlement` on the server. A client flag, a
 * redirect from the payment page, a JWT claim: none of them is an answer.
 *
 * Writers:
 *   - `recordPaidEntitlement` / `endPaidEntitlement`: the payment provider's
 *     webhook only (`lib/razorpay-webhook.ts`).
 *   - `grantEntitlement` / `endGrant`: an admin, audited by the caller.
 */

export interface Subject {
  kind: entitlement_subject
  id: string
}

type Tx = Prisma.TransactionClient

/** Live at `now`: started, and not yet ended. */
function liveAt(now: Date) {
  return {
    starts_at: { lte: now },
    // Both arms explicitly: a bare `not` on a nullable column drops the NULLs
    // (memory: prisma-not-excludes-null), and NULL is "never ends".
    OR: [{ expires_at: null }, { expires_at: { gt: now } }],
  }
}

/**
 * May this subject use this product right now?
 *
 * An Event Pass is about one event, so it needs `eventId` and answers for that
 * event alone. Without one it is false rather than "any pass at all".
 */
export async function hasEntitlement(
  subject: Subject,
  product: entitlement_product,
  opts: { eventId?: string } = {},
  now: Date = new Date()
): Promise<boolean> {
  if (product === "event_pass" && !opts.eventId) return false
  const row = await db.entitlements.findFirst({
    where: {
      subject_kind: subject.kind,
      subject_id: subject.id,
      product,
      ...(product === "event_pass" ? { event_id: opts.eventId } : {}),
      ...liveAt(now),
    },
    select: { id: true },
  })
  return row !== null
}

export interface LiveEntitlement {
  id: string
  source: entitlement_source
  startsAt: Date
  expiresAt: Date | null
}

/**
 * The live row that lasts longest, for saying "until …". Null when none is
 * live. Not a gate: gates call `hasEntitlement`.
 */
export async function liveEntitlement(
  subject: Subject,
  product: Exclude<entitlement_product, "event_pass">,
  now: Date = new Date()
): Promise<LiveEntitlement | null> {
  const rows = await db.entitlements.findMany({
    where: { subject_kind: subject.kind, subject_id: subject.id, product, ...liveAt(now) },
    select: { id: true, source: true, starts_at: true, expires_at: true },
  })
  if (rows.length === 0) return null
  // NULL (never ends) outlasts any date.
  const best = rows.reduce((a, b) =>
    a.expires_at === null ? a : b.expires_at === null || b.expires_at > a.expires_at ? b : a
  )
  return { id: best.id, source: best.source, startsAt: best.starts_at, expiresAt: best.expires_at }
}

/** The same, for many organisations at once (the admin's list). */
export async function liveAnalyticsByOrg(
  orgIds: string[],
  now: Date = new Date()
): Promise<Map<string, LiveEntitlement>> {
  if (orgIds.length === 0) return new Map()
  const rows = await db.entitlements.findMany({
    where: { subject_kind: "org", subject_id: { in: orgIds }, product: "analytics", ...liveAt(now) },
    select: { id: true, subject_id: true, source: true, starts_at: true, expires_at: true },
    orderBy: { expires_at: { sort: "desc", nulls: "first" } },
  })
  const out = new Map<string, LiveEntitlement>()
  for (const r of rows) {
    if (out.has(r.subject_id)) continue
    out.set(r.subject_id, { id: r.id, source: r.source, startsAt: r.starts_at, expiresAt: r.expires_at })
  }
  return out
}

/** Which of these events an organisation holds a live Event Pass for. */
export async function eventPassesFor(
  orgId: string,
  eventIds: string[],
  now: Date = new Date()
): Promise<Set<string>> {
  if (eventIds.length === 0) return new Set()
  const rows = await db.entitlements.findMany({
    where: {
      subject_kind: "org",
      subject_id: orgId,
      product: "event_pass",
      event_id: { in: eventIds },
      ...liveAt(now),
    },
    select: { event_id: true },
  })
  return new Set(rows.map((r) => r.event_id).filter((id): id is string => id !== null))
}

/* -------------------------------------------------------------------------- */
/* Writers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A paid row, from a provider's webhook. One row per provider reference: a
 * renewal moves its end, and a replayed or re-sent payment finds the row it
 * already made. `expiresAt` only ever moves later here; ending is
 * `endPaidEntitlement`.
 */
export async function recordPaidEntitlement(
  tx: Tx,
  input: {
    subject: Subject
    product: entitlement_product
    eventId?: string | null
    source: Exclude<entitlement_source, "grant">
    externalRef: string
    startsAt: Date
    expiresAt: Date | null
  }
): Promise<{ id: string; expiresAt: Date | null }> {
  const existing = await tx.entitlements.findUnique({
    where: { source_external_ref: { source: input.source, external_ref: input.externalRef } },
    select: { id: true, expires_at: true },
  })
  if (existing) {
    const later =
      existing.expires_at === null || input.expiresAt === null
        ? null
        : input.expiresAt > existing.expires_at
          ? input.expiresAt
          : existing.expires_at
    const row = await tx.entitlements.update({
      where: { id: existing.id },
      data: { expires_at: later },
      select: { id: true, expires_at: true },
    })
    return { id: row.id, expiresAt: row.expires_at }
  }
  const row = await tx.entitlements.create({
    data: {
      subject_kind: input.subject.kind,
      subject_id: input.subject.id,
      product: input.product,
      event_id: input.eventId ?? null,
      source: input.source,
      external_ref: input.externalRef,
      starts_at: input.startsAt,
      expires_at: input.expiresAt,
    },
    select: { id: true, expires_at: true },
  })
  return { id: row.id, expiresAt: row.expires_at }
}

/**
 * End a paid row at `at`, never later than it already ends and never before
 * it started. Null when there is no row for that reference (a halt for a
 * subscription that never charged).
 */
export async function endPaidEntitlement(
  tx: Tx,
  source: Exclude<entitlement_source, "grant">,
  externalRef: string,
  at: Date
): Promise<{ id: string; expiresAt: Date } | null> {
  const row = await tx.entitlements.findUnique({
    where: { source_external_ref: { source, external_ref: externalRef } },
    select: { id: true, starts_at: true, expires_at: true },
  })
  if (!row) return null
  const floor = at < row.starts_at ? row.starts_at : at
  const end = row.expires_at !== null && row.expires_at < floor ? row.expires_at : floor
  await tx.entitlements.update({ where: { id: row.id }, data: { expires_at: end } })
  return { id: row.id, expiresAt: end }
}

/** An admin's grant: from now, for `months` calendar months. */
export async function grantEntitlement(input: {
  subject: Subject
  product: Exclude<entitlement_product, "event_pass">
  months: number
  now?: Date
}): Promise<{ id: string; startsAt: Date; expiresAt: Date }> {
  const startsAt = input.now ?? new Date()
  const expiresAt = new Date(startsAt)
  expiresAt.setUTCMonth(expiresAt.getUTCMonth() + input.months)
  const row = await db.entitlements.create({
    data: {
      subject_kind: input.subject.kind,
      subject_id: input.subject.id,
      product: input.product,
      source: "grant",
      starts_at: startsAt,
      expires_at: expiresAt,
    },
    select: { id: true },
  })
  return { id: row.id, startsAt, expiresAt }
}

/**
 * End a live grant now. Only a grant: a paid row is the provider's to end.
 * Null when the id is not a live grant on that subject.
 */
export async function endGrant(
  subject: Subject,
  entitlementId: string,
  now: Date = new Date()
): Promise<{ id: string; product: entitlement_product; expiresAt: Date } | null> {
  const row = await db.entitlements.findFirst({
    where: {
      id: entitlementId,
      subject_kind: subject.kind,
      subject_id: subject.id,
      source: "grant",
      ...liveAt(now),
    },
    select: { id: true, product: true, starts_at: true },
  })
  if (!row) return null
  const end = now < row.starts_at ? row.starts_at : now
  await db.entitlements.update({ where: { id: row.id }, data: { expires_at: end } })
  return { id: row.id, product: row.product, expiresAt: end }
}
