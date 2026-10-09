"use server"

import { Refusal } from "./refusal"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { auditLog } from "@/lib/audit-log"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { placementPhase, type PlacementPhase } from "@/lib/placement-phase"
import { reachBand, type SponsorReachBand } from "@/lib/billing-plans"
import { placementReach, reachKey, type PlacementReach } from "@/lib/sponsor-reach"
import { razorpayKeys } from "@/lib/env"
import { logger } from "@/lib/logger"
import { violatedConstraint } from "@/lib/prisma-errors"
import { createPaymentLink, RazorpayError } from "@/lib/razorpay"

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
  /** Rupees as typed by a person; converted to paise here, once. */
  amount: z.number().positive().max(10_000_000),
  currency: z.literal("INR").default("INR"),
  note: z.string().trim().max(500).optional(),
})

/** The shortest void reason that can say anything, as for a suspension. */
const MIN_VOID_REASON = 10
/** As long as a pricing note; it is copied into the audit row as well. */
const MAX_VOID_REASON = 500

async function requireAdmin() {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") throw new Refusal("Forbidden")
  return session.user
}

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

  const charge = await db.placement_charges.create({
    data: {
      placement_id: placementId,
      amount_minor: amountMinor,
      currency,
      status: "draft",
      priced_by: admin.id,
      external_ref: note || null,
    },
    select: { id: true },
  })

  auditLog({
    userId: admin.id,
    action: "charge.priced",
    resource: "placement_charges",
    resourceId: charge.id,
    details: {
      placementId,
      eventId: placement.event_id,
      sponsorId: placement.sponsor_id,
      amountMinor,
      currency,
    },
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

  /*
   * Only from the status read above. Two voids at once both passed that check,
   * and the second overwrote the first one's who and why.
   */
  const { count } = await db.placement_charges.updateMany({
    where: { id: chargeId, status: charge.status },
    data: {
      status: to,
      ...(to === "agreed" ? { agreed_at: new Date() } : {}),
      ...(to === "settled" ? { settled_at: new Date() } : {}),
      ...(to === "void" ? { voided_at: new Date(), voided_by: admin.id, void_reason: why } : {}),
      ...(ref ? { external_ref: ref } : {}),
    },
  })
  if (count !== 1) throw new Refusal("Someone else changed that charge just now. Reload and look again.")

  auditLog({
    userId: admin.id,
    action: `charge.${to}`,
    resource: "placement_charges",
    resourceId: chargeId,
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
    },
  })

  revalidatePath("/dashboard/charges")
}

/* -------------------------------------------------------------------------- */
/* Payment links (step 17, SCRUM-560)                                          */
/* -------------------------------------------------------------------------- */

/** Razorpay's statuses for a link that can still be paid, or was. */
const LIVE_LINK = ["created", "issued", "partially_paid", "paid"]
const ONE_LINK_PER_CHARGE = "billing_checkouts_one_link_per_charge"

/**
 * Send the sponsor a Razorpay Payment Link for an agreed charge.
 *
 * Writes our record of the link (`billing_checkouts`, kind `payment_link`,
 * the sponsor's organisation, the charge and its amount) and names the link
 * on the charge (`external_ref`). It settles nothing: `payment_link.paid`
 * does, through the webhook, against this record. One link a charge can
 * still be paid through: a second click returns the first.
 *
 * Razorpay emails the link to the sponsor organisation's primary contact,
 * and the sponsor's Placements page shows it.
 */
export async function sendPaymentLink(chargeId: string): Promise<{ linkId: string; payUrl: string | null; reused: boolean }> {
  const admin = await requireAdmin()
  if (!z.uuid().safeParse(chargeId).success) throw new Refusal("Charge not found")
  let paymentsOn = false
  try {
    paymentsOn = razorpayKeys() !== null
  } catch {
    paymentsOn = false
  }
  if (!paymentsOn) throw new Refusal("Payments aren't switched on here yet. Settle this one by hand.")

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
  const sponsor = charge.placement.sponsor
  if (!sponsor.org_id) throw new Refusal("This brand has no organisation yet, so there is nobody to send a link to. Settle it by hand.")
  const orgId = sponsor.org_id
  const contact = sponsor.org?.members[0]?.user ?? null

  let orphan: string | null = null
  try {
    const result = await db.$transaction(
      async (tx) => {
        // One link at a time per charge: the check and the create are one decision.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-link:${chargeId}`}, 0))`
        const open = await tx.billing_checkouts.findFirst({
          where: { charge_id: chargeId, kind: "payment_link", status: { in: LIVE_LINK } },
          select: { provider_ref: true, pay_url: true },
        })
        if (open) return { linkId: open.provider_ref, payUrl: open.pay_url, reused: true }

        const link = await createPaymentLink({
          chargeId,
          orgId,
          amountMinor: charge.amount_minor,
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
        const { count } = await tx.placement_charges.updateMany({
          where: { id: chargeId, status: "agreed" },
          data: { external_ref: link.id },
        })
        if (count !== 1) throw new Refusal("Someone else changed that charge just now. Reload and look again.")
        return { linkId: link.id, payUrl: link.short_url, reused: false }
      },
      { maxWait: 10_000, timeout: 30_000 }
    )
    if (!result.reused) {
      auditLog({
        userId: admin.id,
        action: "charge.link_sent",
        resource: "placement_charges",
        resourceId: chargeId,
        details: {
          paymentLinkId: result.linkId,
          amountMinor: charge.amount_minor,
          currency: charge.currency,
          // What external_ref said before the link replaced it (the pricing note).
          previousRef: charge.external_ref,
          emailed: Boolean(contact?.email),
        },
      })
    }
    revalidatePath("/dashboard/charges")
    revalidatePath("/dashboard/placements")
    return result
  } catch (err) {
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
