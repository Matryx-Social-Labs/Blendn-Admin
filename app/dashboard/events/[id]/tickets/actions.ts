"use server"

import { revalidatePath } from "next/cache"
import { headers } from "next/headers"

import { getAuth } from "@/lib/auth"
import { clientIpFrom } from "@/lib/client-ip"
import { db } from "@/lib/db"
import { reviewPayoutAccount, submitPayoutAccount } from "@/lib/payout-account"
import { overUserLimit } from "@/lib/rate-limit"
import { refundOrder } from "@/lib/ticket-refunds"
import { saveExternalTicketLink, turnOnTicketing } from "@/lib/ticket-setup"
import { saveTicketType } from "@/lib/ticket-types"

/**
 * The Tickets tab's writes (SCRUM-1014). Each is a thin door onto one lib
 * function that authorizes on its own (`eventPermissions` on `actorFor`, or
 * the organization's owners and admins, or app_admin): these only read the
 * session, limit the caller, and turn a refusal into a sentence.
 */

export type ActionResult = { ok: true; message?: string } | { ok: false; message: string }

const SIGNED_OUT: ActionResult = { ok: false, message: "Your session ended. Sign in again." }
const TOO_FAST: ActionResult = { ok: false, message: "Too many changes in a minute. Wait a moment and try again." }

async function caller() {
  const session = await getAuth()
  return session?.user ? { id: session.user.id, role: session.user.role } : null
}

const tab = (eventId: string) => revalidatePath(`/dashboard/events/${eventId}/tickets`)

const TURN_ON_SENTENCE: Record<string, string> = {
  terms_changed: "The terms changed while this page was open. Reload the page, read them again, and accept.",
  not_authorized: "Only an owner or admin of the organization can accept the terms.",
  payouts_not_connected: "Connect a verified payout account first.",
  market_not_native: "Blend’n doesn’t sell tickets for events in this city yet.",
  already_enabled: "Ticket selling is already on for this event.",
  no_organization: "Ticket selling needs an organization behind the event.",
  stale_version: "The terms changed while this page was open. Reload the page and accept again.",
}

export async function turnOnTicketSelling(eventId: string, input: { documentSha256: string; refundPolicy: string; feesAbsorbed: boolean }): Promise<ActionResult> {
  const user = await caller()
  if (!user) return SIGNED_OUT
  if (await overUserLimit("heavy", "tickets-turn-on", user.id)) return TOO_FAST
  const h = await headers()
  const res = await turnOnTicketing(eventId, user, { ...input, ip: clientIpFrom(h), userAgent: h.get("user-agent") })
  tab(eventId)
  return res.ok ? { ok: true } : { ok: false, message: TURN_ON_SENTENCE[res.reason] ?? "Ticket selling could not be turned on." }
}

export async function connectPayoutAccount(eventId: string, accountId: string): Promise<ActionResult> {
  const user = await caller()
  if (!user) return SIGNED_OUT
  if (await overUserLimit("write", "payouts-connect", user.id)) return TOO_FAST
  const res = await submitPayoutAccount(eventId, user, accountId)
  tab(eventId)
  if (res.ok) return { ok: true }
  const sentence = {
    invalid: "A Razorpay linked account id is acc_ followed by 14 letters and numbers.",
    not_authorized: "Only an owner or admin of the organization can connect payouts.",
    already_active: "This organization’s payout account is already verified.",
  } as Record<string, string>
  return { ok: false, message: sentence[res.reason] ?? "The payout account could not be saved." }
}

export async function reviewPayoutAccountFor(eventId: string, decision: "active" | "rejected"): Promise<ActionResult> {
  const user = await caller()
  if (!user) return SIGNED_OUT
  const event = await db.events.findUnique({ where: { id: eventId }, select: { organizer_org_id: true } })
  if (!event?.organizer_org_id) return { ok: false, message: "This event has no organization." }
  const res = await reviewPayoutAccount(event.organizer_org_id, user, decision)
  tab(eventId)
  if (res.ok) return { ok: true }
  const sentence: Record<string, string> = {
    not_authorized: "Only a Blend’n admin verifies payout accounts.",
    no_account: "There is no account waiting.",
    razorpay_disagrees: `Razorpay says this account is “${res.razorpay ?? "not activated"}”, not activated.`,
    razorpay_unreachable: "Razorpay could not be reached. Try again in a minute.",
  }
  return { ok: false, message: sentence[res.reason] ?? "The account could not be updated." }
}

export async function saveTicketLink(eventId: string, url: string): Promise<ActionResult> {
  const user = await caller()
  if (!user) return SIGNED_OUT
  if (await overUserLimit("write", "tickets-external-link", user.id)) return TOO_FAST
  const res = await saveExternalTicketLink(eventId, user, url)
  tab(eventId)
  if (res.ok) return { ok: true, message: res.site ? `The app shows “Tickets on ${res.site}”.` : "The link is gone; the event is free with “I’m going”." }
  return { ok: false, message: res.reason === "invalid" ? (res.message ?? "Use a web address that starts with https://") : "The link could not be saved." }
}

export async function saveTicketTypeForm(eventId: string, form: Record<string, string>): Promise<ActionResult> {
  const user = await caller()
  if (!user) return SIGNED_OUT
  if (await overUserLimit("write", "ticket-types", user.id)) return TOO_FAST
  const res = await saveTicketType(eventId, user, form)
  tab(eventId)
  return res.ok ? { ok: true } : { ok: false, message: res.message }
}

export async function refundSale(eventId: string, orderId: string): Promise<ActionResult> {
  const user = await caller()
  if (!user) return SIGNED_OUT
  if (await overUserLimit("write", "ticket-refund", user.id)) return TOO_FAST
  const res = await refundOrder(orderId, user, "organizer")
  tab(eventId)
  if (res.ok) return { ok: true, message: "Refunded. Razorpay returns the money in 5–7 days." }
  const sentence: Record<string, string> = {
    retrying: "Razorpay didn’t answer. The refund is claimed and will be retried automatically.",
    already_refunding: "This order is already being refunded.",
    not_paid: "Only a paid order can be refunded.",
    payments_off: "Payments are not set up on this server.",
    payout_released: "The payout for this event has been released, so it can’t be refunded from here.",
  }
  const message = sentence[res.reason] ?? "That order could not be refunded."
  // Claimed and queued is done from here: the reconcile job makes it, and the row says "Refunding".
  return res.reason === "retrying" ? { ok: true, message } : { ok: false, message }
}
