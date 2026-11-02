import { z } from "zod"

import { registry } from "@/lib/openapi/registry"
import { bearerAuth, standardErrors, wrap } from "@/lib/openapi/schemas/common"
import { TICKET_REFUSALS, TicketLinesSchema, TicketOrderCreatedSchema, TicketOrderSchema, TicketQuoteSchema, TicketSchema } from "@/lib/openapi/schemas/tickets"

/*
 * Ticketing (SCRUM-1011; .context/plans/ticketing-api-contract.md). Every
 * route is a 404 while the server's TICKETING flag is off. Payment happens on
 * the hosted pay page (`payUrl`), never in the app; "paid" is written by the
 * signed Razorpay webhook only.
 */

const tags = ["Mobile Tickets"]
const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } })
const eventParams = z.object({ eventId: z.string().uuid() })
const orderParams = z.object({ orderId: z.string().uuid() })
const conflict = (description: string) => ({ 409: { description } })

registry.registerPath({
  method: "post",
  path: "/api/mobile/events/{eventId}/ticket-quote",
  tags,
  summary: "Price tickets, holding nothing",
  description:
    "What these lines would cost now. Nothing is held; the order is priced again under its locks and that price is the charge. " +
    TICKET_REFUSALS +
    "A draft or a stranger's private event is 404. Limited per user (60/min) and per network (240/min).",
  security: bearerAuth,
  request: { params: eventParams, body: json(TicketLinesSchema) },
  responses: { 200: { description: "The quote", ...json(wrap(TicketQuoteSchema)) }, ...conflict("Refused: see the codes above"), ...standardErrors },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/events/{eventId}/ticket-orders",
  tags,
  summary: "Hold tickets for 10 minutes and get the pay link",
  description:
    "Holds the seats, creates the Razorpay order for `total_minor` as stored, and returns the pay link. " +
    TICKET_REFUSALS +
    "Also `too_many_holds` (two open holds for this event already) and `busy` (with `retryAfter: 1`; retry at most twice). " +
    "503 when Razorpay cannot take payments; the hold is given back. Limited per user (10/min) and per network (30/min).",
  security: bearerAuth,
  request: { params: eventParams, body: json(TicketLinesSchema) },
  responses: {
    201: { description: "Held", ...json(wrap(TicketOrderCreatedSchema)) },
    ...conflict("Refused: see the codes above"),
    503: { description: "Payments unavailable" },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "get",
  path: "/api/mobile/ticket-orders/{orderId}",
  tags,
  summary: "My order and, once paid, its tickets",
  description: "Buyer only: anyone else's order, or none, is the same 404. The app polls this after the pay page closes (every 1.5 s for up to 30 s).",
  security: bearerAuth,
  request: { params: orderParams },
  responses: { 200: { description: "The order", ...json(wrap(TicketOrderSchema)) }, ...standardErrors },
})

registry.registerPath({
  method: "delete",
  path: "/api/mobile/ticket-orders/{orderId}",
  tags,
  summary: "Let a held order go",
  description: "Buyer only, pending only: the hold is given back now and the order is `cancelled`. A payment that lands on it later is refunded in full.",
  security: bearerAuth,
  request: { params: orderParams },
  responses: { 204: { description: "Released" }, ...conflict("`not_pending`: the order is no longer held"), ...standardErrors },
})

registry.registerPath({
  method: "get",
  path: "/api/mobile/me/tickets",
  tags,
  summary: "My tickets",
  description: "Tickets of my paid orders, newest event first, each with its event so the pass renders offline. Not paginated in v1.",
  security: bearerAuth,
  request: { query: z.object({ eventId: z.string().uuid().optional() }) },
  responses: { 200: { description: "Tickets", ...json(wrap(z.array(TicketSchema))) }, ...standardErrors },
})
