import "server-only"

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
 *   - `applyStoreWindow` / `transferStoreEntitlements`: the stores' webhook
 *     only, through RevenueCat (`lib/revenuecat-webhook.ts`).
 *   - `grantEntitlement` / `endGrants` / `revokePaid`: an admin, audited by
 *     the caller (`lib/billing-actions.ts`).
 *   - `grantPlusOnce`: Blendn+'s own grants, the trial and the referral
 *     month (`lib/plus.ts`).
 *   - `eraseUserEntitlements`: the account erasure.
 */

export interface Subject {
  kind: entitlement_subject
  id: string
}

type Tx = Prisma.TransactionClient
type Client = Tx | typeof db

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
  now: Date = new Date(),
  client: Client = db
): Promise<boolean> {
  if (product === "event_pass" && !opts.eventId) return false
  const row = await client.entitlements.findFirst({
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

/**
 * The live grant, if any, whatever else is live. An admin acts on a grant;
 * a longer paid row beside it must not hide it from them.
 */
export async function liveGrant(
  subject: Subject,
  product: Exclude<entitlement_product, "event_pass">,
  now: Date = new Date(),
  client: Client = db
): Promise<LiveEntitlement | null> {
  const row = await client.entitlements.findFirst({
    // An admin's grant has no reference; a trial or referral month (lib/plus.ts) has one.
    where: { subject_kind: subject.kind, subject_id: subject.id, product, source: "grant", external_ref: null, ...liveAt(now) },
    orderBy: { expires_at: { sort: "desc", nulls: "first" } },
    select: { id: true, source: true, starts_at: true, expires_at: true },
  })
  return row ? { id: row.id, source: row.source, startsAt: row.starts_at, expiresAt: row.expires_at } : null
}

/** One subject's live grant and longest live paid row, apart (the admin's control on a venue). */
export async function liveGrantAndPaid(
  subject: Subject,
  product: Exclude<entitlement_product, "event_pass">,
  now: Date = new Date()
): Promise<{ grant: LiveEntitlement | null; paid: LiveEntitlement | null }> {
  const rows = await db.entitlements.findMany({
    where: { subject_kind: subject.kind, subject_id: subject.id, product, ...liveAt(now) },
    select: { id: true, source: true, starts_at: true, expires_at: true },
    orderBy: { expires_at: { sort: "desc", nulls: "first" } },
  })
  const as = (r: (typeof rows)[number] | undefined) =>
    r ? { id: r.id, source: r.source, startsAt: r.starts_at, expiresAt: r.expires_at } : null
  return { grant: as(rows.find((r) => r.source === "grant")), paid: as(rows.find((r) => r.source !== "grant")) }
}

/** For many organisations at once (the admin's list): the live grant and the longest paid row, apart. */
export async function liveAnalyticsByOrg(
  orgIds: string[],
  now: Date = new Date()
): Promise<Map<string, { grant: LiveEntitlement | null; paid: LiveEntitlement | null }>> {
  if (orgIds.length === 0) return new Map()
  const rows = await db.entitlements.findMany({
    where: { subject_kind: "org", subject_id: { in: orgIds }, product: "analytics", ...liveAt(now) },
    select: { id: true, subject_id: true, source: true, starts_at: true, expires_at: true },
    orderBy: { expires_at: { sort: "desc", nulls: "first" } },
  })
  const out = new Map<string, { grant: LiveEntitlement | null; paid: LiveEntitlement | null }>()
  for (const r of rows) {
    const entry = out.get(r.subject_id) ?? { grant: null, paid: null }
    const live = { id: r.id, source: r.source, startsAt: r.starts_at, expiresAt: r.expires_at }
    if (r.source === "grant") entry.grant ??= live
    else entry.paid ??= live
    out.set(r.subject_id, entry)
  }
  return out
}

/** The events an organisation holds a live Event Pass for (all of them, or among `eventIds`). */
export async function eventPassesFor(
  orgId: string,
  eventIds?: string[],
  now: Date = new Date(),
  client: Client = db
): Promise<Set<string>> {
  if (eventIds && eventIds.length === 0) return new Set()
  const rows = await client.entitlements.findMany({
    where: {
      subject_kind: "org",
      subject_id: orgId,
      product: "event_pass",
      ...(eventIds ? { event_id: { in: eventIds } } : {}),
      ...liveAt(now),
    },
    select: { event_id: true },
  })
  return new Set(rows.map((r) => r.event_id).filter((id): id is string => id !== null))
}

/**
 * Does the organisation already hold a live Event Pass for this event from
 * another purchase? The webhook asks, inside its transaction, before granting
 * a second one.
 */
export async function passHeldElsewhere(
  client: Client,
  orgId: string,
  eventId: string,
  exceptRef: string,
  now: Date
): Promise<boolean> {
  const n = await client.entitlements.count({
    where: {
      subject_kind: "org",
      subject_id: orgId,
      product: "event_pass",
      event_id: eventId,
      NOT: { external_ref: exceptRef },
      ...liveAt(now),
    },
  })
  return n > 0
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

/**
 * `months` calendar months after `from`, on the same day of the month or the
 * month's last day: 31 Oct + 6 is 30 Apr, never 1 May (JavaScript's own
 * setUTCMonth rolls over).
 */
export function addMonths(from: Date, months: number): Date {
  const out = new Date(from)
  const day = out.getUTCDate()
  out.setUTCDate(1)
  out.setUTCMonth(out.getUTCMonth() + months)
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate()
  out.setUTCDate(Math.min(day, last))
  return out
}

/**
 * An admin's grant: from now, for `months` calendar months. The caller holds
 * the subject's advisory lock in `tx`, so "no live grant" and the insert are
 * one decision (only one live grant per subject).
 */
export async function grantEntitlement(
  tx: Tx,
  input: {
    subject: Subject
    product: Exclude<entitlement_product, "event_pass">
    months: number
    now?: Date
  }
): Promise<{ id: string; startsAt: Date; expiresAt: Date }> {
  const startsAt = input.now ?? new Date()
  const expiresAt = addMonths(startsAt, input.months)
  const row = await tx.entitlements.create({
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
 * End every live grant on this subject and product, now. Only grants: a paid
 * row is the provider's to end, or an admin's to revoke (`revokePaid`).
 * Returns how many ended.
 */
export async function endGrants(
  subject: Subject,
  product: Exclude<entitlement_product, "event_pass">,
  now: Date = new Date(),
  client: Client = db
): Promise<number> {
  const { count } = await client.entitlements.updateMany({
    // An admin's grants only (no reference): never a trial or referral month.
    where: { subject_kind: subject.kind, subject_id: subject.id, product, source: "grant", external_ref: null, ...liveAt(now) },
    // A live row has started (liveAt), so `now` is never before starts_at.
    data: { expires_at: now },
  })
  return count
}

/**
 * An admin ends a live PAID row now (a refund handled outside Razorpay, a
 * mistake). Never a grant: that is `endGrants`. Null when the id is not a live
 * paid row on that subject.
 */
export async function revokePaid(
  subject: Subject,
  entitlementId: string,
  now: Date = new Date(),
  client: Client = db
): Promise<{ id: string; product: entitlement_product; externalRef: string | null } | null> {
  const { count } = await client.entitlements.updateMany({
    where: {
      id: entitlementId,
      subject_kind: subject.kind,
      subject_id: subject.id,
      source: { not: "grant" },
      ...liveAt(now),
    },
    data: { expires_at: now },
  })
  if (count === 0) return null
  const row = await client.entitlements.findUniqueOrThrow({
    where: { id: entitlementId },
    select: { id: true, product: true, external_ref: true },
  })
  return { id: row.id, product: row.product, externalRef: row.external_ref }
}

/**
 * End now every live PAID row on this subject and product that one of these
 * provider references paid for (a venue changing hands, `billing-actions`).
 * Never a grant. Returns the rows ended.
 */
export async function revokePaidByRefs(
  subject: Subject,
  product: Exclude<entitlement_product, "event_pass">,
  refs: string[],
  now: Date = new Date(),
  client: Client = db
): Promise<{ id: string }[]> {
  if (refs.length === 0) return []
  const rows = await client.entitlements.findMany({
    where: { subject_kind: subject.kind, subject_id: subject.id, product, source: { not: "grant" }, external_ref: { in: refs }, ...liveAt(now) },
    select: { id: true },
  })
  if (rows.length) {
    await client.entitlements.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { expires_at: now } })
  }
  return rows
}

/* -------------------------------------------------------------------------- */
/* Blendn+ (step 11): a person's Plus, from the stores and from our own grants */
/* -------------------------------------------------------------------------- */

export type StoreSource = Extract<entitlement_source, "apple" | "google">
export type PlusProduct = Extract<entitlement_product, "plus" | "night_pass">

const userPlus = (userId: string) => ({
  subject_kind: "user" as const,
  subject_id: userId,
  product: { in: ["plus", "night_pass"] as entitlement_product[] },
})

/** What a person holds now, for saying so (`GET /me/plus`): the live row that lasts longest. Not a gate. */
export async function livePlus(
  userId: string,
  now: Date = new Date()
): Promise<{ product: PlusProduct; source: entitlement_source; expiresAt: Date | null } | null> {
  const row = await db.entitlements.findFirst({
    where: { ...userPlus(userId), ...liveAt(now) },
    orderBy: { expires_at: { sort: "desc", nulls: "first" } },
    select: { product: true, source: true, expires_at: true },
  })
  return row ? { product: row.product as PlusProduct, source: row.source, expiresAt: row.expires_at } : null
}

/** The row a store purchase made, if any: what it is and when it started. */
export async function storeRow(
  tx: Tx,
  source: StoreSource,
  externalRef: string
): Promise<{ product: PlusProduct; startsAt: Date; subjectId: string; windowTransactionId: string | null } | null> {
  const row = await tx.entitlements.findUnique({
    where: { source_external_ref: { source, external_ref: externalRef } },
    select: { product: true, starts_at: true, subject_id: true, window_transaction_id: true },
  })
  return row
    ? { product: row.product as PlusProduct, startsAt: row.starts_at, subjectId: row.subject_id, windowTransactionId: row.window_transaction_id }
    : null
}

/**
 * When this person's last Night Pass not yet over ends, other than
 * `exceptRef`: a new one stacks after it (D-16). Not yet over, not "live" —
 * a pass already stacked to start tomorrow counts, so a third bought today
 * goes after the second, not on top of it.
 */
export async function nightPassEnd(tx: Tx, userId: string, exceptRef: string, now: Date): Promise<Date | null> {
  const row = await tx.entitlements.findFirst({
    where: {
      subject_kind: "user",
      subject_id: userId,
      product: "night_pass",
      NOT: { external_ref: exceptRef },
      expires_at: { gt: now },
    },
    orderBy: { expires_at: "desc" },
    select: { expires_at: true },
  })
  return row?.expires_at ?? null
}

/**
 * One store purchase's window, as the store saw it at `eventAt`. The caller
 * (the RevenueCat webhook) holds the person's lock.
 *
 *   - No row yet: made for `userId`, or nothing when the purchase's owner is
 *     not one of our people (`no_owner`: recorded by the caller, never granted).
 *   - A row: its window moves to this one only if no newer event already set
 *     it (`window_event_at`), and its owner to `userId` only if no newer event
 *     or transfer already set that (`owner_event_at`). Both are conditional
 *     updates, so two deliveries racing on one row settle by the store's clock
 *     whatever order they commit in.
 *
 * A window never ends before its row started (the CHECK): a refund before a
 * stacked Night Pass began ends it at its start.
 */
export async function applyStoreWindow(
  tx: Tx,
  w: {
    userId: string | null
    product: PlusProduct
    source: StoreSource
    externalRef: string
    startsAt: Date
    expiresAt: Date
    eventAt: Date
    /** The store transaction this event is about (`transaction_id`). */
    transactionId: string | null
  }
): Promise<"created" | "applied" | "stale" | "no_owner"> {
  const key = { source_external_ref: { source: w.source, external_ref: w.externalRef } }
  const row = await tx.entitlements.findUnique({ where: key, select: { id: true, starts_at: true } })
  if (!row) {
    if (!w.userId) return "no_owner"
    await tx.entitlements.create({
      data: {
        subject_kind: "user",
        subject_id: w.userId,
        product: w.product,
        source: w.source,
        external_ref: w.externalRef,
        starts_at: w.startsAt,
        expires_at: w.expiresAt < w.startsAt ? w.startsAt : w.expiresAt,
        window_event_at: w.eventAt,
        owner_event_at: w.eventAt,
        window_transaction_id: w.transactionId,
      },
    })
    return "created"
  }
  const notNewer = (col: "window_event_at" | "owner_event_at") => ({
    OR: [{ [col]: null }, { [col]: { lte: w.eventAt } }],
  })
  const { count } = await tx.entitlements.updateMany({
    where: { id: row.id, ...notNewer("window_event_at") },
    data: {
      expires_at: w.expiresAt < row.starts_at ? row.starts_at : w.expiresAt,
      window_event_at: w.eventAt,
      ...(w.transactionId ? { window_transaction_id: w.transactionId } : {}),
    },
  })
  if (w.userId) {
    await tx.entitlements.updateMany({
      where: { id: row.id, ...notNewer("owner_event_at") },
      data: { subject_id: w.userId, owner_event_at: w.eventAt },
    })
  }
  return count ? "applied" : "stale"
}

/**
 * A store's TRANSFER: the store-bought Plus rows of `from` that RevenueCat now
 * holds under `to` — matched by a transaction RevenueCat reports for `to`
 * (`confirmed`): the purchase's own reference, or the transaction behind its
 * current window — move to `to`, unless a newer event already decided their
 * owner. Nothing else of `from`'s moves. Returns how many moved.
 */
export async function transferStoreEntitlements(
  tx: Tx,
  input: { from: string[]; to: string; sources: StoreSource[]; at: Date; confirmed: string[] }
): Promise<number> {
  if (input.from.length === 0 || input.confirmed.length === 0) return 0
  const { count } = await tx.entitlements.updateMany({
    where: {
      subject_kind: "user",
      subject_id: { in: input.from },
      product: { in: ["plus", "night_pass"] },
      source: { in: input.sources },
      AND: [
        { OR: [{ external_ref: { in: input.confirmed } }, { window_transaction_id: { in: input.confirmed } }] },
        { OR: [{ owner_event_at: null }, { owner_event_at: { lte: input.at } }] },
      ],
    },
    data: { subject_id: input.to, owner_event_at: input.at },
  })
  return count
}

/** How many of Blendn+'s own grants with this reference prefix this person has had since `since` (the referral month's yearly cap). */
export async function plusGrantsSince(client: Client, userId: string, refPrefix: string, since: Date): Promise<number> {
  return client.entitlements.count({
    where: { subject_kind: "user", subject_id: userId, source: "grant", external_ref: { startsWith: refPrefix }, created_at: { gte: since } },
  })
}

/**
 * Blendn+ from us, once per `ref` ever: the unique (source, external_ref)
 * makes a second run, or a race, a no-op. True when this call granted it.
 */
export async function grantPlusOnce(
  client: Client,
  input: { userId: string; ref: string; startsAt: Date; expiresAt: Date }
): Promise<boolean> {
  const { count } = await client.entitlements.createMany({
    data: [
      {
        subject_kind: "user",
        subject_id: input.userId,
        product: "plus",
        source: "grant",
        external_ref: input.ref,
        starts_at: input.startsAt,
        expires_at: input.expiresAt,
      },
    ],
    skipDuplicates: true,
  })
  return count === 1
}

/**
 * The account erasure: a person's Blendn+ rows go with them (test plan D-17).
 * The deliveries in `payment_events` stay — ids and times, no personal data —
 * and the person is told to cancel in their store. Returned unawaited, so the
 * erasure can put it in its one batch transaction.
 */
export function eraseUserEntitlements(userId: string) {
  return db.entitlements.deleteMany({ where: { subject_kind: "user", subject_id: userId } })
}
