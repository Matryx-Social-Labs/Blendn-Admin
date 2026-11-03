# Ticketing on the dashboard (Phase 4, SCRUM-1014)

Everything here is behind `TICKETING` (off by default, `lib/env.ts`
`ticketingOn`). Plans: `.context/plans/ticketing.md`,
`ticketing-business-model.md` §4, `ticketing-api-contract.md` §8–9. The mobile
routes are in `docs/API.md` § Tickets. Design chain:
`.context/design/tickets-tab/CHAIN.md`, mockup `tickets-tab-20261102`.

## Routes

| Route | Who | What |
|---|---|---|
| `/dashboard/events/[id]/tickets` | `eventPermissions(...).canEdit`, an event (`kind = event`) whose market sells (`loadEventPage`'s `ticketing`: its own mode, else its city's market's) | The Tickets tab. Before selling: payout account, fees, who pays, refund policy, terms. Selling: the money's path, ticket types, sales, payout, refunds. External market (Canada): a link out. |
| `/dashboard/events/[id]/door` | `canOperate` (the organization, the venue's owner, an admin), event selling natively | "Check tickets": the sixth character or a QR scan admits in one step. Linked from the Tickets tab and from Live. |
| `/terms/organizer-tickets` | public | The Organizer Ticketing Terms, the same body as the tab's scroll panel. |

The Tickets tab is a tab (`eventTabsFor`, `"tickets"`); the door is a page of its
own with its own header (`OWNED_HEADERS`). A venue owner never sees Tickets and
a URL does not get them there: the page redirects to the overview.

## Server actions

`app/dashboard/events/[id]/tickets/actions.ts` and `.../door/actions.ts`. Each
reads the session, limits the caller (`overUserLimit`), calls one lib function
that authorizes for itself, and answers in a sentence.

| Action | Lib | Rule |
|---|---|---|
| `connectPayoutAccount` | `submitPayoutAccount` (`lib/payout-account.ts`) | An owner or admin of the event's organization (or an app_admin) enters the Razorpay Route linked account id, `acc_` + 14; status `pending`. An `active` account is not replaced from here. Audit `payouts.account_submitted`. |
| `reviewPayoutAccountFor` | `reviewPayoutAccount` | app_admin only. `active` only when Razorpay's `GET /v2/accounts/:id` says `activated` (`linkedAccountStatus`, `lib/razorpay.ts`); without Razorpay keys the row records `razorpay: "not_checked"`. Or `rejected`. Audit `payouts.account_reviewed`. |
| `turnOnTicketSelling` | `turnOnTicketing` (`lib/ticket-setup.ts`) | canEdit. The page's terms hash must equal the server's hash of the file it serves now (`terms_changed` otherwise). Payouts connected and a native market are checked before anything is recorded. If the organization has not accepted the version in force, `recordLegalAcceptance` with the **server's** `document_sha256` (owners and admins only); then the refund policy and who pays are written, then `enableTicketing`. |
| `saveTicketTypeForm` | `saveTicketType` (`lib/ticket-types.ts`) | canEdit, event selling natively. At most 20 types an event, hidden ones counted, under a `FOR NO KEY UPDATE` lock on the event. Price > 0 (free is RSVP plus capacity). Quantity ≥ sold + held. Most per order 1–10. Window in the event's timezone. Off sale = `hidden`. A price change applies to new orders only (orders keep `unit_price_minor` and `total_minor`) and writes `ticket_type.price_changed` with what was sold. |
| `refundSale` | `refundOrder` (`lib/ticket-refunds.ts`) | canEdit on the order's event. Refunds the organizer's share (the booking fee is kept, terms 5.4), behind a confirmation dialog whose default is Keep. Not offered once the payout is released. |
| `saveTicketLink` | `saveExternalTicketLink` | canEdit, the city's market is `external`. https only (`httpsUrl`); the app's "Tickets on <site>" is derived from the link's host. Nothing fetches the link. Empty turns the event back to free. |
| `admitTicket` | `admitAtDoor` (`lib/ticket-door.ts`) | canOperate, checked before any attempt counts. 30 attempts a minute per operator at the event, 300 a minute for the event, then `redeemTicket` (one conditional UPDATE). Answers a code, the type and a time: never a person. |

A cancelled event refunds every paid order in full through the cancel paths
that already exist (the dashboard and mobile event PATCH routes, the admin
status move): `refundAllOnCancel` calls `cancelEventRefundAll` after the cancel
commits and never throws; a refund Razorpay cannot make now is claimed and the
reconcile job retries it.

## What the tab reads

`lib/ticket-sales.ts`: `salesPage` (50 a page, newest first, search by order
reference or attendee label, filter by type and status) and `ticketsSummary`
(sold, refunded, the organizer's share, release date = event end + 3 days).
Buyers are their attendee label (`attendeeLabel` with `labelScopeFor`, as in
Attendees and the exports); no name, email or buyer id reaches a row. The
Refunds panel names the member who refunded, from the refund's audit row.

## Not built (v1)

- Hosted KYC onboarding from the dashboard (Razorpay creates and verifies the
  linked account): the organization does it with Razorpay and enters the id.
- Bank name and last four on the payout line: nothing stores them.
- Drag to reorder types (types keep their creation order), CSV export of
  sales, an organization-level Payouts page.
- Changing the refund policy or who pays after selling starts.
