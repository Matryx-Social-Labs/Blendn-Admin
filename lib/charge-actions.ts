"use server"

import { Refusal } from "./refusal"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { paymentsOn } from "@/lib/billing"
import { requireAdmin } from "@/lib/current-user"
import { db } from "@/lib/db"
import { placementPhase, type PlacementPhase } from "@/lib/placement-phase"
import { reachBand, type SponsorReachBand } from "@/lib/billing-plans"
import { placementReach, reachKey, type PlacementReach } from "@/lib/sponsor-reach"
import { logger } from "@/lib/logger"
import { violatedConstraint } from "@/lib/prisma-errors"
import { hit } from "@/lib/rate-limit-store"
import {
  cancelPaymentLink,
  createPaymentLink,
  notifyPaymentLink,
  PAYMENT_LINK_LIFETIME_MS,
  paymentLinkStatus,
  RazorpayError,
} from "@/lib/razorpay"
import { lockCharge } from "@/lib/razorpay-webhook"

/**
 * What a placement costs, and whether it has been paid.
 *
 * ## A ledger, with a payment link beside it
 *
 * What this records is *what was agreed*, so that six months later there is
 * one answer to "did they pay for that" instead of a thread in somebody's
 * inbox. Since step 17 an agreed charge can be paid by a Razorpay Payment
 * Link (`sendPaymentLink`), which the webhook settles; money that arrives any
 * other way is still settled by hand with its reference.
 *
 * `external_ref` is the pricing note while a draft, the link's id once one is
 * sent, and otherwise whatever reference the finance side uses. Deliberately
 * free text for that last case.
 *
 * ## Minor units, integers, never a float
 *
 * ₹1,250.50 is `125050`. A float would be fine until it was not, and the first
 * time it is not is a reconciliation that is off by a paisa and nobody can say
 * why. The same reason totals are always grouped by currency: summing minor
 * units across currencies yields a number in no currency at all.
 *
 * ## Why draft → agreed → settled, and void beside them
 *
 * `draft` is a price somebody typed. `agreed` is a price the sponsor accepted —
 * the moment it becomes a receivable. `settled` is money arrived. Collapsing the
 * first two loses the distinction between "we asked for this" and "they said
 * yes", which is the whole question a chase-up email turns on.
 *
 * `void` exists so a mistake can be undone without deleting the record of it,
 * and the migration's partial unique — one non-void charge per placement — is
 * what lets a corrected charge be raised afterwards. A hard `@unique` would have
 * made the first typo permanent.
 */

const priceSchema = z.object({
  /**
   * Rupees as typed by a person; converted to paise here, once. At least ₹1
   * (Razorpay's smallest payment) and whole paise: 0.015 was stored as 2 paise
   * and 0.50 accepted (final review D4).
   */
  amount: z
    .number()
    .min(1, "A charge is at least ₹1.")
    .max(10_000_000)
    .multipleOf(0.01, "Rupees and paise: two decimals at most."),
  currency: z.literal("INR").default("INR"),
  note: z.string().trim().max(500).optional(),
})

/** Moves of a charge per admin a minute: a void or a settle may call Razorpay. */
const CHARGE_MOVES = { max: 30, windowMs: 60_000 }

/** A UTR is 22 characters, a cheque number fewer; this is room to spare, not a free-text field. */
const MAX_PAYMENT_REF = 100

/** The shortest void reason that can say anything, as for a suspension. */
const MIN_VOID_REASON = 10
/** As long as a pricing note; it is copied into the audit row as well. */
const MAX_VOID_REASON = 500

export interface ChargeRow {
  id: string
  amountMinor: number
  currency: string
  status: "draft" | "agreed" | "settled" | "void"
  agreedAt: Date | null
  settledAt: Date | null
  externalRef: string | null
  pricedByName: string | null
  createdAt: Date
  /** The latest Razorpay Payment Link sent for it, if any (step 17). */
  link: { id: string; status: string; payUrl: string | null } | null
}

export interface ChargeablePlacement {
  placementId: string
  eventId: string
  eventTitle: string
  eventStart: Date
  eventEnd: Date
  brandName: string
  ownerName: string | null
  phase: PlacementPhase
  /** How many sends ran. Each is an exposure of everyone in the room, not reach. */
  sends: number
  /** Distinct people reached (held back under 5), and its pricing band (step 17, F8). */
  reach: PlacementReach | null
  band: SponsorReachBand | null
  /** The live charge, if one has been raised. Voided ones are history. */
  charge: ChargeRow | null
  /** Voided charges, newest first — kept on the row so a reversal is never invisible (SCRUM-173). */
  voided: VoidedCharge[]
}

export interface VoidedCharge {
  id: string
  amountMinor: number
  currency: string
  /** Where it was when voided, read from the stamps it had reached. */
  fromStatus: "draft" | "agreed" | "settled"
  /** The payment reference, when it had been settled; before that `external_ref` holds the pricing note. */
  externalRef: string | null
  /** Null only on a void from before reasons were kept — those have no voider either. */
  reason: string | null
  voidedAt: Date | null
  voidedByName: string | null
}

export interface ChargeLedger {
  placements: ChargeablePlacement[]
  /** Grouped by currency, because a cross-currency sum is meaningless. */
  totals: { currency: string; agreedMinor: number; settledMinor: number }[]
}

/**
 * Every approved placement and what it has been charged.
 *
 * Includes the ones with no charge at all — those are the point of the screen.
 * A list of existing charges answers "what have we billed"; this answers "what
 * have we run and not billed", which is the question that loses money.
 */
export async function getChargeLedger(): Promise<ChargeLedger> {
  await requireAdmin()

  const rows = await db.event_sponsors.findMany({
    where: { status: "approved" },
    select: {
      id: true,
      status: true,
      sponsor: {
        select: { id: true, name: true, org: { select: { display_name: true } } },
      },
      event: {
        select: {
          id: true,
          title: true,
          start_time: true,
          end_time: true,
          /*
           * `sponsor_id` comes back so the sum below can be scoped to THIS
           * placement's brand.
           *
           * This selected the count alone, so every brand's row on this screen
           * showed the total sends by every sponsor at that event — two brands
           * at one night and both rows read double. `getSponsorOverview` filters
           * the same relation by `sponsor_id` and always has; two readers of one
           * relation gave two answers, and this is the one used to decide what
           * to bill.
           *
           * Filtered here rather than in the query because a nested `where`
           * cannot reference the parent row's `sponsor_id`.
           */
          sponsored_messages: {
            select: { sponsor_id: true, _count: { select: { sends: true } } },
          },
        },
      },
      // Every charge, split below: the live one, and the voided ones kept as history.
      charges: {
        orderBy: { created_at: "desc" },
        select: {
          id: true,
          amount_minor: true,
          currency: true,
          status: true,
          agreed_at: true,
          settled_at: true,
          external_ref: true,
          created_at: true,
          voided_at: true,
          voided_by: true,
          void_reason: true,
          pricer: { select: { name: true } },
          payment_links: {
            orderBy: { created_at: "desc" },
            take: 1,
            select: { provider_ref: true, status: true, pay_url: true },
          },
        },
      },
    },
    orderBy: { event: { start_time: "desc" } },
  })

  const now = new Date()

  const voiderIds = [...new Set(rows.flatMap((r) => r.charges.map((c) => c.voided_by)).filter((id): id is string => !!id))]
  const voiders = new Map(
    (voiderIds.length ? await db.user.findMany({ where: { id: { in: voiderIds } }, select: { id: true, name: true } }) : []).map(
      (u) => [u.id, u.name]
    )
  )

  const reaches = await placementReach(rows.map((r) => ({ eventId: r.event.id, sponsorId: r.sponsor.id })))

  const placements: ChargeablePlacement[] = rows.map((r) => {
    const charge = r.charges.find((c) => c.status !== "void")
    const reach = reaches.get(reachKey(r.event.id, r.sponsor.id)) ?? null
    return {
      placementId: r.id,
      eventId: r.event.id,
      eventTitle: r.event.title,
      eventStart: r.event.start_time,
      eventEnd: r.event.end_time,
      brandName: r.sponsor.name,
      ownerName: r.sponsor.org?.display_name ?? null,
      phase: placementPhase({ status: r.status }, r.event, now),
      sends: r.event.sponsored_messages
        .filter((m) => m.sponsor_id === r.sponsor.id)
        .reduce((n, m) => n + m._count.sends, 0),
      reach,
      band: reachBand(reach?.reach ?? null),
      charge: charge
        ? {
            id: charge.id,
            amountMinor: charge.amount_minor,
            currency: charge.currency,
            status: charge.status,
            agreedAt: charge.agreed_at,
            settledAt: charge.settled_at,
            externalRef: charge.external_ref,
            pricedByName: charge.pricer?.name ?? null,
            createdAt: charge.created_at,
            link: charge.payment_links[0]
              ? { id: charge.payment_links[0].provider_ref, status: charge.payment_links[0].status, payUrl: charge.payment_links[0].pay_url }
              : null,
          }
        : null,
      voided: r.charges
        .filter((c) => c.status === "void")
        .map((c) => ({
          id: c.id,
          amountMinor: c.amount_minor,
          currency: c.currency,
          fromStatus: c.settled_at ? ("settled" as const) : c.agreed_at ? ("agreed" as const) : ("draft" as const),
          externalRef: c.settled_at ? c.external_ref : null,
          reason: c.void_reason,
          voidedAt: c.voided_at,
          voidedByName: (c.voided_by && voiders.get(c.voided_by)) ?? null,
        })),
    }
  })

  /*
   * One row per currency. `currency_code` has one value today, which is exactly
   * when this is cheap to get right — the second value is added by someone who
   * will not think to check every SUM in the codebase.
   */
  const byCurrency = new Map<string, { agreedMinor: number; settledMinor: number }>()
  for (const p of placements) {
    if (!p.charge) continue
    const bucket = byCurrency.get(p.charge.currency) ?? { agreedMinor: 0, settledMinor: 0 }
    if (p.charge.status === "agreed") bucket.agreedMinor += p.charge.amountMinor
    if (p.charge.status === "settled") bucket.settledMinor += p.charge.amountMinor
    byCurrency.set(p.charge.currency, bucket)
  }

  return {
    placements,
    totals: [...byCurrency.entries()].map(([currency, t]) => ({ currency, ...t })),
  }
}

/** Raise a draft charge against a placement. */
export async function pricePlacement(placementId: string, input: unknown): Promise<void> {
  const admin = await requireAdmin()
  if (!z.uuid().safeParse(placementId).success) throw new Refusal("Placement not found")

  const parsed = priceSchema.safeParse(input)
  if (!parsed.success) throw new Refusal(parsed.error.issues[0]?.message ?? "Invalid amount")
  const { amount, currency, note } = parsed.data

  const placement = await db.event_sponsors.findUnique({
    where: { id: placementId },
    select: { id: true, event_id: true, sponsor_id: true, status: true },
  })
  if (!placement) throw new Refusal("Placement not found")
  if (placement.status !== "approved") {
    // Charging for something nobody agreed to run is a conversation, not a row.
    throw new Refusal("That placement is not approved.")
  }

  const existing = await db.placement_charges.findFirst({
    where: { placement_id: placementId, status: { not: "void" } },
    select: { id: true },
  })
  /*
   * Refused here as well as by the partial unique index. The constraint is what
   * makes it true; this is what makes it a sentence rather than a 500.
   */
  if (existing) throw new Refusal("This placement already has a charge. Void it first.")

  // Rounded once, here, at the boundary between what a person typed and what is
  // stored. Every read from now on is an integer.
  const amountMinor = Math.round(amount * 100)

  // The price and its audit row, together or not at all.
  await db.$transaction(async (tx) => {
    const charge = await tx.placement_charges.create({
      data: {
        placement_id: placementId,
        amount_minor: amountMinor,
        currency: currency,
        status: "draft",
        priced_by: admin.id,
        external_ref: note || null,
      },
      select: { id: true },
    })
    await tx.audit_logs.create({
      data: {
        user_id: admin.id,
        action: "charge.priced",
        resource: "placement_charges",
        resource_id: charge.id,
        details: { placementId, eventId: placement.event_id, sponsorId: placement.sponsor_id, amountMinor, currency },
      },
    })
  })

  revalidatePath("/dashboard/charges")
}

/**
 * Move a charge along: agreed, settled, or void.
 *
 * The transitions are one-way and explicit rather than a free `status` setter.
 * "Settled" going back to "draft" is not a state change, it is a correction, and
 * a correction should leave the void behind it.
 */
export async function advanceCharge(
  chargeId: string,
  to: "agreed" | "settled" | "void",
  externalRef?: string,
  reason?: string
): Promise<void> {
  const admin = await requireAdmin()
  if (!z.uuid().safeParse(chargeId).success) throw new Refusal("Charge not found")
  // After authorisation, before any Razorpay call (a void or settle cancels a link); refusals count too.
  const { count: moves } = await hit(`charges:advance:${admin.id}`, CHARGE_MOVES.windowMs)
  if (moves > CHARGE_MOVES.max) throw new Refusal("Too many changes in a minute. Wait a moment and try again.")

  const charge = await db.placement_charges.findUnique({
    where: { id: chargeId },
    select: { id: true, status: true, placement_id: true, amount_minor: true, currency: true, external_ref: true },
  })
  if (!charge) throw new Refusal("Charge not found")
  if (charge.status === "void") throw new Refusal("That charge was voided.")

  const allowed: Record<string, string[]> = {
    draft: ["agreed", "void"],
    agreed: ["settled", "void"],
    // A settled charge can still be voided — money comes back sometimes — but
    // it cannot walk backwards into "agreed".
    settled: ["void"],
  }
  if (!allowed[charge.status]?.includes(to)) {
    throw new Refusal(`A ${charge.status} charge cannot become ${to}.`)
  }

  /*
   * A settlement with no reference is a claim nobody can check against a bank
   * statement, which is the only reason this row exists.
   */
  const ref = externalRef?.trim() ?? ""
  if (to === "settled" && ref.length < 3) {
    throw new Refusal("Record the payment reference — it is what makes this checkable.")
  }
  if (ref.length > MAX_PAYMENT_REF) throw new Refusal(`Keep the payment reference under ${MAX_PAYMENT_REF} characters.`)

  /*
   * A void can undo money that arrived, and it cannot be undone (SCRUM-173). It
   * was one click with nothing asked; now it needs a reason the next person can
   * read, like a suspension or a brand merge.
   */
  const why = reason?.trim() ?? ""
  if (to === "void" && why.length < MIN_VOID_REASON) {
    throw new Refusal("Give a reason — the next person reconciling this needs to know why.")
  }
  if (why.length > MAX_VOID_REASON) throw new Refusal(`Keep the reason under ${MAX_VOID_REASON} characters.`)

  // Links Razorpay closed during this attempt, named if our side then fails.
  const closed: string[] = []
  try {
    await db.$transaction(
      async (tx) => {
        /*
         * One admin action on this charge at a time: a void waits for a send in
         * flight, then closes the link it made (review H1).
         *
         * A settle by hand or a void first closes any payment link still open
         * for the charge, at Razorpay, so a sponsor cannot pay a voided or
         * already-paid charge through it. Locked in the webhook's order — the
         * link's row, then the charge — so the two decide one after the other.
         * A link with money coming through it, or one Razorpay will not cancel,
         * stops the change: nothing is written.
         */
        await oneAtATime(tx, chargeId)
        if (to === "settled" || to === "void") await closeOpenLinks(tx, chargeId, closed)
        const locked = await lockCharge(tx, chargeId)
        if (!locked || locked.status !== charge.status) throw new Refusal(CHANGED_JUST_NOW)

        /*
         * Only from the status read above. Two voids at once both passed that
         * check, and the second overwrote the first one's who and why.
         */
        const { count } = await tx.placement_charges.updateMany({
          where: { id: chargeId, status: charge.status },
          data: {
            status: to,
            ...(to === "agreed" ? { agreed_at: new Date() } : {}),
            ...(to === "settled" ? { settled_at: new Date() } : {}),
            ...(to === "void" ? { voided_at: new Date(), voided_by: admin.id, void_reason: why } : {}),
            ...(ref ? { external_ref: ref } : {}),
          },
        })
        if (count !== 1) throw new Refusal(CHANGED_JUST_NOW)

        // In the transaction: a change to money is never without its record.
        await tx.audit_logs.create({
          data: {
            user_id: admin.id,
            action: CHARGE_ACTION[to],
            resource: "placement_charges",
            resource_id: chargeId,
            details: {
              placementId: charge.placement_id,
              from: charge.status,
              amountMinor: charge.amount_minor,
              currency: charge.currency,
              // The reference the charge carries, not only one passed in now: a void
              // arrives with none, and "which payment was undone" is its whole point.
              // Before settlement `external_ref` is the pricing note, not a payment.
              externalRef: ref || (charge.status === "settled" ? charge.external_ref : null) || null,
              ...(to === "void" ? { reason: why } : {}),
              ...(closed.length ? { closedLinks: closed } : {}),
            },
          },
        })
      },
      { maxWait: 10_000, timeout: 30_000 }
    )
  } catch (err) {
    // Closed at Razorpay and not here: payment_link.cancelled records it, and
    // the next attempt finds it closed (closeAtRazorpay).
    if (closed.length) {
      logger.error("Payment links were cancelled at Razorpay but the charge was not changed", {
        chargeId,
        paymentLinkIds: closed,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    throw err
  }

  revalidatePath("/dashboard/charges")
  revalidatePath("/dashboard/placements")
}

/* -------------------------------------------------------------------------- */
/* Payment links (step 17, SCRUM-560)                                          */
/* -------------------------------------------------------------------------- */

const CHARGE_ACTION = { agreed: "charge.agreed", settled: "charge.settled", void: "charge.void" } as const
const CHANGED_JUST_NOW = "Someone else changed that charge just now. Reload and look again."
const PAID_THROUGH_LINK = "A payment came through this charge's link. Let it settle, or refund it at Razorpay first."

/** Razorpay's statuses for a link that can still be paid, or was. */
const LIVE_LINK = ["created", "issued", "partially_paid", "paid"]
/** A link no payment has reached yet: cancellable. */
const UNPAID_LINK = ["created", "issued"]
const ONE_LINK_PER_CHARGE = "billing_checkouts_one_link_per_charge"
/** Sends of a link per admin: each is a Razorpay call and an email. */
const LINK_SENDS = { max: 10, windowMs: 60_000 }

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0]

/**
 * Admin actions on one charge, one at a time, until the transaction ends.
 * Taken before any row lock, and the webhook never takes it, so the row locks
 * keep the webhook's order (link, then charge) and cannot deadlock with it.
 */
async function oneAtATime(tx: Tx, chargeId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`charge:${chargeId}`}, 0))`
}

/**
 * Close every payment link still open for a charge, at Razorpay first, and
 * only then mark ours closed. Refuses — writing nothing — when money is
 * coming through a link (paid or partly paid) or Razorpay will not cancel it.
 * Each link Razorpay closed goes into `closed` at once, so a failure after it
 * can name it.
 */
async function closeOpenLinks(tx: Tx, chargeId: string, closed: string[]): Promise<void> {
  const links = await tx.$queryRaw<{ id: string; provider_ref: string; status: string }[]>`
    SELECT id::text AS id, provider_ref, status
      FROM billing_checkouts
     WHERE charge_id = ${chargeId}::uuid AND kind = 'payment_link'
       AND status IN ('created', 'issued', 'partially_paid', 'paid')
       FOR UPDATE`
  for (const link of links) {
    if (!UNPAID_LINK.includes(link.status)) throw new Refusal(PAID_THROUGH_LINK)
    const status = await closeAtRazorpay(chargeId, link.provider_ref)
    closed.push(link.provider_ref)
    await tx.billing_checkouts.update({ where: { id: link.id }, data: { status: status, status_at: new Date() } })
  }
}

/**
 * Cancel a link at Razorpay. One Razorpay had already closed — an earlier
 * attempt that cancelled it and then failed here, or its expiry — counts as
 * closed, so a second attempt goes through rather than refusing for ever.
 * One that was paid is the paid refusal.
 */
async function closeAtRazorpay(chargeId: string, linkId: string): Promise<string> {
  try {
    await cancelPaymentLink(linkId)
    return "cancelled"
  } catch (err) {
    const now = await paymentLinkStatus(linkId).catch(() => null)
    if (now && (now.status === "cancelled" || now.status === "expired")) return now.status
    logger.error("Razorpay would not cancel a payment link; the charge was left as it was", {
      chargeId,
      paymentLinkId: linkId,
      razorpayStatus: now?.status ?? null,
      error: err instanceof Error ? err.message : String(err),
    })
    if (now && !UNPAID_LINK.includes(now.status)) throw new Refusal(PAID_THROUGH_LINK)
    throw new Refusal("Razorpay wouldn't cancel this charge's payment link, so nothing was changed. Try again in a minute.")
  }
}

/**
 * Send the sponsor a Razorpay Payment Link for an agreed charge.
 *
 * Writes our record of the link (`billing_checkouts`, kind `payment_link`,
 * the sponsor's organisation, the charge and its amount). It settles nothing:
 * `payment_link.paid` does, through the webhook, against this record. The
 * charge keeps its pricing note in `external_ref` until it is settled (the
 * webhook then names the link there); the link is tied by `charge_id`.
 *
 * One link a charge can still be paid through: a second click returns the
 * first, and a link older than Razorpay keeps it is expired first. The charge
 * is locked and re-checked BEFORE Razorpay is asked, so a void racing this
 * waits and then cancels the new link. The link is created silent and
 * emailed only once our record is committed; if our side fails after
 * Razorpay made it, it is cancelled (review H4).
 */
export async function sendPaymentLink(chargeId: string): Promise<{ linkId: string; payUrl: string | null; reused: boolean }> {
  const admin = await requireAdmin()
  if (!z.uuid().safeParse(chargeId).success) throw new Refusal("Charge not found")
  // After authorisation, before any Razorpay call; refusals count too.
  const { count: sends } = await hit(`charges:link:${admin.id}`, LINK_SENDS.windowMs)
  if (sends > LINK_SENDS.max) throw new Refusal("Too many payment links in a minute. Wait a moment and try again.")
  if (!paymentsOn()) throw new Refusal("Payments aren't switched on here yet. Settle this one by hand.")

  const charge = await db.placement_charges.findUnique({
    where: { id: chargeId },
    select: {
      id: true,
      status: true,
      amount_minor: true,
      currency: true,
      external_ref: true,
      placement: {
        select: {
          event: { select: { title: true } },
          sponsor: {
            select: {
              name: true,
              org_id: true,
              org: {
                select: {
                  status: true,
                  members: {
                    where: { role: { in: ["owner", "admin"] } },
                    orderBy: [{ is_primary_contact: "desc" }, { created_at: "asc" }],
                    take: 1,
                    select: { user: { select: { name: true, email: true } } },
                  },
                },
              },
            },
          },
        },
      },
    },
  })
  if (!charge) throw new Refusal("Charge not found")
  if (charge.status !== "agreed") {
    throw new Refusal("Only an agreed charge is paid by link. Mark it agreed once the sponsor accepts the price.")
  }
  if (charge.currency !== "INR") throw new Refusal("Payment links are in rupees only.")
  const sponsor = charge.placement.sponsor
  if (!sponsor.org_id) throw new Refusal("This brand has no organisation yet, so there is nobody to send a link to. Settle it by hand.")
  if (sponsor.org?.status === "suspended") throw new Refusal("This brand's organisation is suspended.")
  const orgId = sponsor.org_id
  const contact = sponsor.org?.members[0]?.user ?? null

  let orphan: string | null = null
  try {
    const result = await db.$transaction(
      async (tx) => {
        // After any other admin action on this charge; then the links, then
        // the charge: the webhook's order, and the void's.
        await oneAtATime(tx, chargeId)
        await tx.$queryRaw`SELECT id FROM billing_checkouts WHERE charge_id = ${chargeId}::uuid FOR UPDATE`
        const locked = await lockCharge(tx, chargeId)
        if (!locked || locked.status !== "agreed" || locked.amount_minor !== charge.amount_minor || locked.currency !== "INR") {
          throw new Refusal(CHANGED_JUST_NOW)
        }
        // And the brand, under the lock: still the organisation read above, not suspended.
        const brandNow = await tx.placement_charges.findUnique({
          where: { id: chargeId },
          select: { placement: { select: { sponsor: { select: { org_id: true, org: { select: { status: true } } } } } } },
        })
        const sponsorNow = brandNow?.placement.sponsor
        if (!sponsorNow || sponsorNow.org_id !== orgId || sponsorNow.org?.status === "suspended") throw new Refusal(CHANGED_JUST_NOW)
        // A link Razorpay has already expired (it lives 14 days) is not open,
        // even when its expiry event never reached us.
        await tx.billing_checkouts.updateMany({
          where: {
            charge_id: chargeId,
            kind: "payment_link",
            status: { in: UNPAID_LINK },
            created_at: { lt: new Date(Date.now() - PAYMENT_LINK_LIFETIME_MS - 24 * 60 * 60 * 1000) },
          },
          data: { status: "expired" },
        })
        const open = await tx.billing_checkouts.findFirst({
          where: { charge_id: chargeId, kind: "payment_link", status: { in: LIVE_LINK } },
          select: { provider_ref: true, pay_url: true },
        })
        if (open) return { linkId: open.provider_ref, payUrl: open.pay_url, reused: true }

        const link = await createPaymentLink({
          chargeId,
          orgId,
          amountMinor: charge.amount_minor,
          currency: "INR",
          description: `${sponsor.name} at ${charge.placement.event.title} — sponsored placement`,
          customer: contact?.email ? { name: contact.name, email: contact.email } : null,
        })
        orphan = link.id
        await tx.billing_checkouts.create({
          data: {
            kind: "payment_link",
            provider_ref: link.id,
            org_id: orgId,
            charge_id: chargeId,
            plan_key: "placement_charge",
            amount_minor: charge.amount_minor,
            currency: charge.currency,
            status: link.status || "created",
            pay_url: link.short_url,
            created_by: admin.id,
          },
        })
        await tx.audit_logs.create({
          data: {
            user_id: admin.id,
            action: "charge.link_sent",
            resource: "placement_charges",
            resource_id: chargeId,
            details: {
              paymentLinkId: link.id,
              amountMinor: charge.amount_minor,
              currency: charge.currency,
              emailed: Boolean(contact?.email),
            },
          },
        })
        return { linkId: link.id, payUrl: link.short_url, reused: false }
      },
      { maxWait: 10_000, timeout: 30_000 }
    )
    // Committed: the link is ours now, and nothing below may cancel it.
    orphan = null
    if (!result.reused && contact?.email) {
      // Only now, with our record committed, is the sponsor told.
      await notifyPaymentLink(result.linkId).catch((err: unknown) =>
        logger.error("Razorpay did not email the payment link; it is on the sponsor's Placements page", {
          chargeId,
          paymentLinkId: result.linkId,
          error: err instanceof Error ? err.message : String(err),
        })
      )
    }
    revalidatePath("/dashboard/charges")
    revalidatePath("/dashboard/placements")
    return result
  } catch (err) {
    if (orphan) {
      // Razorpay made a link our side did not keep: close it, never leave it payable.
      const ref = orphan
      logger.error("A payment link Razorpay made was not kept here; cancelling it", {
        chargeId,
        orphanProviderRef: ref,
        error: err instanceof Error ? err.message : String(err),
      })
      await cancelPaymentLink(ref).catch((cancelErr: unknown) =>
        logger.error("An orphan payment link could not be cancelled; cancel it from the Razorpay dashboard", {
          chargeId,
          paymentLinkId: ref,
          error: cancelErr instanceof Error ? cancelErr.message : String(cancelErr),
        })
      )
    }
    if (err instanceof Refusal) throw err
    if (violatedConstraint(err, ONE_LINK_PER_CHARGE)) throw new Refusal("A link for this charge was sent just now. Reload to see it.")
    if (err instanceof RazorpayError) {
      logger.error("Razorpay payment link failed", { status: err.status, error: err.message, chargeId })
      throw new Refusal("Razorpay didn't accept that just now. Try again in a minute.")
    }
    logger.error("Saving the payment link failed", {
      error: err instanceof Error ? err.message : String(err),
      chargeId,
      orphanProviderRef: orphan,
    })
    throw new Refusal("Something went wrong on our side. Try again in a minute.")
  }
}
