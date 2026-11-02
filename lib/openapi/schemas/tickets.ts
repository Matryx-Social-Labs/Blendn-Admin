import { z } from "zod"

/* Ticketing (SCRUM-1011, .context/plans/ticketing-api-contract.md §1–6, §8). Money is integer minor units plus an ISO currency. */

export const TicketTypeSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable().describe("Always null in v1"),
    priceMinor: z.number().int().positive().describe("Never 0: free is an RSVP plus capacity, not a ticket type"),
    status: z.enum(["on_sale", "sold_out", "not_started", "ended"]),
    remaining: z.number().int().nullable().describe("Only while on sale with 20 or fewer left; otherwise null"),
    salesStartAt: z.string().nullable(),
    salesEndAt: z.string().nullable(),
    maxPerOrder: z.number().int(),
  })
  .openapi("TicketType")

export const EventTicketingSchema = z
  .union([
    z.object({
      mode: z.literal("external"),
      externalUrl: z.string().describe("https, opened in the in-app browser"),
      externalSite: z.string().describe("The URL's own hostname with `www.` stripped, derived on the server: never stored or sent separately"),
    }),
    z.object({
      mode: z.literal("native"),
      currency: z.string(),
      fromMinor: z.number().int().nullable().describe("The cheapest on-sale type's price; null when none is on sale"),
      feesAbsorbed: z.boolean(),
      refundPolicy: z.enum(["none", "until_7d", "until_24h"]),
      types: z.array(TicketTypeSchema).describe("Sorted by position. Hidden and free types never appear"),
      mine: z.object({ ticketCount: z.number().int(), orderIds: z.array(z.string().uuid()) }).nullable().describe("The viewer's paid orders; null when none"),
    }),
  ])
  .nullable()
  .openapi("EventTicketing", { description: "Null while the server's TICKETING flag is off, or the event sells nothing" })

export const TicketLinesSchema = z
  .object({ lines: z.array(z.object({ typeId: z.string().uuid(), quantity: z.number().int().min(1).max(100) })).min(1).max(20) })
  .openapi("TicketLines")

export const TicketQuoteSchema = z
  .object({
    currency: z.string(),
    subtotalMinor: z.number().int(),
    bookingFeeMinor: z.number().int().describe("0 when the organizer absorbs the fees"),
    totalMinor: z.number().int(),
    taxLabel: z.string().describe("What the tax on the fee is called in the event's market: `GST` in India, else `Tax`"),
    feeParts: z
      .object({ serviceMinor: z.number().int(), taxMinor: z.number().int(), processingMinor: z.number().int() })
      .optional()
      .describe("Omitted when the organizer absorbs the fees"),
    lines: z.array(z.object({ typeId: z.string().uuid(), quantity: z.number().int(), unitMinor: z.number().int() })),
  })
  .openapi("TicketQuote")

export const TicketOrderCreatedSchema = z
  .object({
    orderId: z.string().uuid(),
    status: z.literal("pending"),
    totalMinor: z.number().int().describe("`ticket_orders.total_minor`: what Razorpay is asked for"),
    currency: z.string(),
    holdExpiresAt: z.string(),
    payUrl: z.string().describe("`<PAY_BASE_URL>/pay/o/<orderId>?t=<token>`; the token is signed, 15 minutes, bound to the order and buyer. Opaque to the app"),
  })
  .openapi("TicketOrderCreated")

export const TicketSchema = z
  .object({
    ticketId: z.string().uuid(),
    orderId: z.string().uuid(),
    eventId: z.string().uuid(),
    typeName: z.string(),
    doorCode: z.string().describe("Six characters, e.g. `K7Q2XM`; the app shows `K7Q 2XM`"),
    qrPayload: z.string().describe("`<ticketId>.<mac>`, derived on the server, never stored"),
    redeemedAt: z.string().nullable(),
    event: z.object({
      id: z.string().uuid(),
      title: z.string(),
      startsAt: z.string(),
      endsAt: z.string(),
      timezone: z.string().nullable(),
      venueName: z.string().nullable(),
      coverUrl: z.string().nullable(),
    }),
  })
  .openapi("Ticket")

export const TicketOrderSchema = z
  .object({
    orderId: z.string().uuid(),
    eventId: z.string().uuid(),
    status: z.enum(["pending", "paid", "expired", "refunded", "cancelled"]),
    holdExpiresAt: z.string(),
    totalMinor: z.number().int(),
    currency: z.string(),
    paymentFailed: z.boolean().describe("The latest checkout attempt failed (Razorpay `payment.failed`); cleared when the pay page starts another. Only ever true while pending"),
    tickets: z.array(TicketSchema).describe("Empty unless paid"),
  })
  .openapi("TicketOrder")

export const TICKET_REFUSALS =
  "First the RSVP's door, with the RSVP's own answers: 404 for a draft or a stranger's private event, 403 `AGE_RESTRICTED` (`reasonCode` " +
  "`AGE_RESTRICTED` or `AGE_UNKNOWN`) under an event's minimum age, 403 `FORBIDDEN` + `PROFILE_INCOMPLETE` for an account not set up. " +
  "Then refusals are 409 with the code in `errorCode`: `sold_out`, `not_on_sale`, `over_order_limit`, `over_buyer_limit` (more than 10 seats for one " +
  "buyer, held and paid together), `unknown_ticket_type` (also a hidden type), `private` (someone the door lets in, e.g. its organizer), and `age` as a backstop only. "
