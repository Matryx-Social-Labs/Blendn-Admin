import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { standardErrors, wrap, bearerAuth } from "@/lib/openapi/schemas/common"

/*
 * Regulars, blind offers and the door pass (step 12). A venue on Venue Pro
 * sends an offer to its regulars (3+ nights in 30 days, after its claim); the
 * person sees it here. Nothing on this side names anybody else, and the venue
 * learns counts only — the dashboard's side is server actions, not this API.
 */

const OfferSchema = z
  .object({
    id: z.string().uuid().describe("The offer's id: the same for everyone it went to, answered only for them."),
    venue: z.object({ id: z.string().uuid(), name: z.string() }),
    text: z.string().max(140).describe("The venue's words."),
    sentAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    state: z
      .enum(["live", "redeemed", "used_tonight", "ended"])
      .describe(
        "`live`: the pass can be shown. `used_tonight`: another of this venue's passes was redeemed tonight (one a night; only on GET /offers/{offerId}). `ended`: past its end, or the venue was retired or changed hands."
      ),
  })
  .openapi("VenueOffer")

const OpenedOfferSchema = OfferSchema.extend({
  pass: z
    .object({
      code: z.string().length(6).describe("Six characters staff type at the door. Changes every 30 s; a screenshot's stops working within a minute."),
      rotatesAt: z.string().datetime().describe("When the code turns: ask again before then."),
    })
    .nullable()
    .describe("Only while `live`."),
}).openapi("VenueOfferOpened")

const RegularPrefsSchema = z
  .object({
    known: z
      .boolean()
      .describe("\"Let this venue know I'm a regular\", to the organisation that runs it now: it sees your first name and your nights there in the last 30. A new owner sees none of an earlier owner's yeses."),
    offersMuted: z.boolean().describe("No offers from this venue (kept across a change of owner)."),
    ownerName: z.string().nullable().describe("Who would see it: the organisation that runs the venue on Blendn now; null while nobody does."),
  })
  .openapi("RegularPrefs")

registry.registerPath({
  method: "get",
  path: "/api/mobile/offers",
  tags: ["Mobile Offers"],
  summary: "The offers venues sent you",
  description: "Newest first, at most 50. Reading the list opens nothing. Not cached.",
  security: bearerAuth,
  responses: {
    200: { description: "Your offers", content: { "application/json": { schema: wrap(z.object({ offers: z.array(OfferSchema) })) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "get",
  path: "/api/mobile/offers/{offerId}",
  tags: ["Mobile Offers"],
  summary: "Open an offer, and its door pass",
  description:
    "The first open is what the venue's \"opened\" counts. While `live`, `pass` carries the current code: " +
    "ask again before `rotatesAt` while the pass is on screen. Staff redeem it on the dashboard; the next " +
    "answer says `redeemed`. 404 for an offer you were not sent, the same as for none.",
  security: bearerAuth,
  request: { params: z.object({ offerId: z.string().uuid() }) },
  responses: {
    200: { description: "The offer", content: { "application/json": { schema: wrap(z.object({ offer: OpenedOfferSchema })) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "get",
  path: "/api/mobile/venues/{venueId}/regular",
  tags: ["Mobile Offers"],
  summary: "Your choices about a venue",
  security: bearerAuth,
  request: { params: z.object({ venueId: z.string().uuid() }) },
  responses: {
    200: { description: "Your choices", content: { "application/json": { schema: wrap(RegularPrefsSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "put",
  path: "/api/mobile/venues/{venueId}/regular",
  tags: ["Mobile Offers"],
  summary: "Change your choices about a venue",
  description:
    "Each field a real boolean, at least one; a missing one is left as it is (\"Maybe later\" sends nothing). " +
    "Each change is audited. `known: true` — 409 `VENUE_UNCLAIMED` while nobody runs the venue on Blendn, " +
    "403 `AGE_RESTRICTED` without an adult age on file.",
  security: bearerAuth,
  request: {
    params: z.object({ venueId: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ known: z.boolean().optional(), offersMuted: z.boolean().optional() }).strict(),
        },
      },
    },
  },
  responses: {
    200: { description: "Your choices now", content: { "application/json": { schema: wrap(RegularPrefsSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/offers/{offerId}/report",
  tags: ["Mobile Offers"],
  summary: "Report an offer you were sent",
  description:
    "Into the reports queue as a venue offer, with its words as they read. 404 for an offer you were not sent; " +
    "409 `CONFLICT` while your earlier report on it is pending.",
  security: bearerAuth,
  request: {
    params: z.object({ offerId: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({ reason: z.enum(["offensive", "misleading", "spam", "unsafe", "other"]), description: z.string().max(500).optional() })
            .strict(),
        },
      },
    },
  },
  responses: {
    200: { description: "Reported", content: { "application/json": { schema: wrap(z.object({ reported: z.literal(true) })) } } },
    ...standardErrors,
  },
})

const OffersSettingSchema = z
  .object({
    enabled: z.boolean().describe("\"Offers from places\": off, no venue's offer reaches you. On unless turned off."),
    pushes: z
      .boolean()
      .describe(
        "Offer notifications (SCRUM-628, App Store 4.5.4): off until the person says yes in the app. Off, offers still arrive with no push. Independent of `enabled`."
      ),
  })
  .openapi("OffersSetting")

registry.registerPath({
  method: "get",
  path: "/api/mobile/me/offers",
  tags: ["Mobile Offers"],
  summary: "Offers from places, and offer notifications",
  security: bearerAuth,
  responses: {
    200: { description: "The setting", content: { "application/json": { schema: wrap(OffersSettingSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "put",
  path: "/api/mobile/me/offers",
  tags: ["Mobile Offers"],
  summary: "Change offers from places, or offer notifications",
  description: "Each field a real boolean, at least one; a missing one is left as it is. A yes to `pushes` is stored with when it was first given (a second yes keeps it); a no clears it.",
  security: bearerAuth,
  request: {
    body: { content: { "application/json": { schema: z.object({ enabled: z.boolean().optional(), pushes: z.boolean().optional() }).strict() } } },
  },
  responses: {
    200: { description: "The setting now", content: { "application/json": { schema: wrap(OffersSettingSchema) } } },
    ...standardErrors,
  },
})
