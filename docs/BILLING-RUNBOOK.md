# Billing runbook (Razorpay, and Blendn+ through RevenueCat)

What to do when money and the dashboard disagree. The design is in
`lib/razorpay-webhook.ts`; this is the operator's half. Blendn+ (the app's
store purchases) is its own section at the end; its setup is
docs/IAP-SETUP.md.

## Setup, per environment

| Variable | Where it comes from | Notes |
|---|---|---|
| `RAZORPAY_KEY_ID` | Razorpay dashboard → API keys | `rzp_test_…` everywhere except production; `rzp_live_…` only where `RAILWAY_ENVIRONMENT_NAME=production`. The wrong mode refuses to boot. |
| `RAZORPAY_KEY_SECRET` | same | |
| `RAZORPAY_WEBHOOK_SECRET` | chosen by us when registering the webhook, 32+ characters | Required once the keys are set: keys without it would take money and grant nothing. |

Register the webhook at `https://<api host>/api/webhooks/razorpay` with these
events: `subscription.activated`, `subscription.charged`,
`subscription.pending`, `subscription.halted`, `subscription.cancelled`,
`subscription.completed`, `subscription.paused`, `subscription.resumed`,
`payment.captured`, `payment.failed`, `order.paid`, `payment_link.paid`,
`payment_link.expired`, `payment_link.cancelled`, `refund.processed`,
`payment.dispute.created`, `payment.dispute.lost`, `payment.dispute.won`.
**Owner action (step 17):** add `payment_link.expired` and
`payment_link.cancelled` to an already-registered webhook; without them a link
closed at Razorpay stays "open" here until a new send expires it.
Then run `npx tsx scripts/razorpay-plans.ts --apply` once with that
environment's keys (dry run without `--apply`).

## Sponsor payment links (step 17)

On Charges, an **agreed** charge for a claimed brand gets "Send payment link":
a Razorpay Payment Link in the charge's own amount, emailed by Razorpay to the
sponsor organisation's primary contact and shown on the sponsor's Placements
page as "Pay ₹…". Our record of it is a `billing_checkouts` row (kind
`payment_link`, the sponsor's organisation, `charge_id`, `pay_url`); the
charge keeps its pricing note in `external_ref` until the link settles it.
The link is created silent and emailed only once our record is committed; if
our side fails after Razorpay made it, it is cancelled at Razorpay and the id
logged (`orphanProviderRef`). A second click returns the open link; links
expire after 14 days, after which a new one can be sent (a stale one is
marked expired then, even if `payment_link.expired` never arrived). Ten sends
a minute per admin.

**Void and "Payment received" close the link first.** Razorpay cancels it,
then our row says so, then the charge moves, in one transaction with its
audit row (`closedLinks`). If money already came through the link (paid or
partly paid, here or at Razorpay) the change is refused: let the webhook
settle it, or refund at Razorpay. If Razorpay will not cancel, nothing
changes; try again. If Razorpay cancelled and our side then failed, the log
names the link (`paymentLinkIds`) and the next attempt goes through. Sends,
voids and settlements on one charge run one at a time; thirty moves a minute
per admin.

`payment_link.paid` settles the charge, once, against that row: the amount,
currency and "paid" status must match it and the charge. `notes` are never
read. Then, by case:

- **Already settled by this link:** a replay changes nothing.
- **Settled some other way** (by hand, a bank transfer): the sponsor paid
  twice. `charge.paid_twice` and an error log. **Refund the link's payment
  from the Razorpay dashboard**; its refund leaves the hand settlement alone.
- **Voided:** a charge voided before the payment landed stays void. The
  webhook writes `charge.paid_after_void` and logs an error. **Refund it from
  the Razorpay dashboard.**
- **Refunded:** a full refund (`refund.processed`) voids the charge this link
  settled, with the refund id as the reason — also when Razorpay delivered the
  refund before the payment.
- **Disputed:** `charge.disputed` and an error log; answer it at Razorpay. A
  dispute lost voids the charge this link settled.
- **Any other state** (a link is only sent for an agreed charge):
  `charge.paid_unexpected` and an error log; the payment is recorded and the
  charge left as it is. Reconcile it by hand.

Money that arrives any other way is still settled by hand with "Payment
received" and its reference.

## Venue Pro (step 17)

A venue owner buys Venue Pro per venue on `/dashboard/plan` (₹2,999 a month or
₹29,990 a year, before GST; `lib/billing-plans.ts`). The purchase is a
`billing_checkouts` row naming the venue (`venue_id`); the webhook grants the
**venue** (`entitlements.subject_kind = 'venue'`, product `venue_pro`), never
the organisation. One open subscription per venue
(`billing_checkouts_one_open_subscription_per_venue`); an organisation's own
Analytics keeps its own index.

- **No charge before four weeks of venue-day data.** Checkout refuses until 28
  days after the first person went live at the venue (`lib/venue-plan.ts`);
  the Plan page shows each venue's days of data. Nothing to do by hand.
- **Founding grant: 3 months per claimed Bengaluru venue.** An admin gives it
  from the venue's page (Venue Pro panel), with a reason; it is audited on the
  venue. A grant blocks buying until it ends: subscribe after it.
- `scripts/razorpay-plans.ts --apply` creates the two Venue Pro plans with the
  others; run it once per environment after this ships.
- **The payer controls its mandate.** Cancelling is authorised on the
  organisation that pays (`billing_checkouts.org_id`), not on who owns the
  venue today, and the Plan page lists only the caller's organisation's
  subscriptions and payments.
- **A venue changing hands** (an approved dispute) ends the previous owner's
  paid Venue Pro in the same transaction as the transfer
  (`entitlement.ended_on_transfer` on the venue), then cancels its mandate at
  the end of the paid cycle. A cancel Razorpay refused is audited
  `billing.subscription.cancel_failed` on the venue: **cancel it from the
  Razorpay dashboard**. If it charges anyway the webhook grants nothing
  (`billing.payer_not_owner`) and cancels it; refund that payment. Grants
  stay; end them on the venue page.
- **Cancels: Razorpay first, then us.** A cancel Razorpay refused changes
  nothing here and the user is told so. One Razorpay confirmed whose record
  here failed is logged (`providerRef`) and refused; Razorpay's
  `subscription.cancelled` settles the row and the entitlement. Every state
  change and its audit row are one transaction; the money actions read the
  role from the database, not the session.
- **`superseded`** on a subscription is ours: a second mandate paid late
  beside a live one. The webhook cancels it at Razorpay and writes
  `billing.duplicate_subscription`; **refund that payment** from the Razorpay
  dashboard. A checkout we had expired and the customer paid anyway takes the
  open slot, and the unpaid one beside it is cancelled.

## Razorpay's retries, and when it gives up

- The webhook answers 200 for every delivery whose signature verifies,
  including one it refused to apply (`payment_events.error` says why:
  `unknown_ref`, `plan_mismatch`, `amount_mismatch`, `malformed`). Retrying a
  refusal would change nothing.
- It answers 5xx only when the database failed. The whole delivery is one
  transaction, so nothing was half-applied, and Razorpay's retry applies it.
- **Razorpay retries a failing webhook for about 24 hours and then disables
  it.** A disabled webhook means every later payment is taken and never
  granted. Alert on any 5xx from `/api/webhooks/razorpay` (Sentry, or the
  Railway log line `POST /api/webhooks/razorpay 500`), and re-enable the
  webhook in the Razorpay dashboard once the cause is fixed.

## A payment that was taken but not granted

1. Find it: `SELECT provider_event_id, type, error, received_at FROM payment_events ORDER BY received_at DESC LIMIT 20` and the logger line `Razorpay delivery refused` (it names the subscription, order or payment id).
2. If the webhook was down: in the Razorpay dashboard, Webhooks → the webhook → the failed deliveries → **Resend**. A resend carries the same event id and body, so one that did land is a no-op.
3. If it was refused (`amount_mismatch`, `plan_mismatch`): the amount or plan Razorpay reported is not the one this server started. Do not hand-write an entitlement. Refund from the Razorpay dashboard, or, if the purchase is genuine, give the organisation a grant from Organisations (audited) and file a bug with the delivery.
4. Never write `entitlements` by hand: an admin grant is the lever.

## Refunds, disputes, a second pass

- A full refund (`refund.processed`) ends what the payment bought at
  Razorpay's time for the refund; a refunded subscription is also cancelled at
  Razorpay. A partial refund changes nothing.
- A dispute opened or lost ends it; a dispute won restores it.
- `entitlement.duplicate_pass` in `audit_logs` (and a logger error) means an
  organisation paid twice for one event's pass. Refund the second order from
  the Razorpay dashboard.
- To end paid access by hand (a refund done outside Razorpay, a mistake):
  Organisations → the organisation → Revoke. It does not cancel or refund at
  Razorpay; do that there.

## Rolling back

The migration that created these tables is additive. Rolling back the CODE is
safe. Rolling back the SCHEMA is a new forward migration that drops the four
tables (`entitlements`, `payment_events`, `billing_payments`,
`billing_checkouts`); export `payment_events`, `billing_payments` and
`billing_checkouts` first, because once a real payment has landed they are
GST records, kept for 72 months. Never run SQL by hand against staging or
production: the next boot's `prisma migrate deploy` dies on a schema it did not
write.

## Blendn+ (RevenueCat, step 11)

The app's Blendn+ is sold by Apple and Google; RevenueCat tells us. The design
is in `lib/revenuecat-webhook.ts`; setup, per environment, is
docs/IAP-SETUP.md. Razorpay never sells Blendn+ (a database CHECK refuses the
row, and `__tests__/plus-gate-boundary.test.ts` the code).

- **Every authorised delivery answers 200**, including one that changed
  nothing. `payment_events` (`provider = 'revenuecat'`) keeps each one — ids,
  products and times; never the subscriber attributes, aliases or country —
  and `error` says why it changed nothing:
  - `stale`: older than what we hold for that purchase. Normal: RevenueCat
    retries out of order. Each event carries the purchase's whole state, so the
    newer one already said it.
  - `wrong_environment`: a sandbox purchase in production, or a real one on
    staging. App Review buys in the sandbox against production: the review
    account holds a grant instead (docs/IAP-SETUP.md).
  - `unknown_user`: `app_user_id` is not one of our accounts (anonymous, or
    deleted). **Money was taken and nothing granted** — see below.
  - `not_ours` / `unsupported_store`: not a Blendn+ product, or not the App
    Store / Play. Check the RevenueCat entitlement `plus` and product ids.
  - `malformed`: a purchase with no transaction id or end date. File a bug
    with the delivery.
- **5xx only when the database failed.** The whole delivery is one
  transaction, so the claim rolled back with it and RevenueCat's retry applies
  it. RevenueCat retries five times (5, 10, 20, 40, 80 minutes) and then
  stops for that event. Alert on any 5xx from `/api/webhooks/revenuecat`.
- **A delivery that never landed** (the retries ran out): for a subscription,
  the next event about it — renewal, cancellation, expiration — carries the
  whole state and puts the row right. A Night Pass has no next event: find
  the purchase in RevenueCat → Customers → the user id, and give the person
  the time by hand only through a grant (there is no admin control for a
  person's grant yet — SCRUM-583; until then, file it and refund from the
  store's side if asked).
- **Refunds** are the store's: Apple's or Google's. RevenueCat reports one as
  a CANCELLATION with `cancel_reason = CUSTOMER_SUPPORT`, and the webhook ends
  access at that moment. `REFUND_REVERSED` gives it back.
- **A deleted account** loses its Blendn+ rows with the account (D-17); the
  person is told to cancel in their store. A later renewal for that account
  is `unknown_user`.
- **Rolling back** step 11's migration (`20261010120000_blendn_plus`) is a new
  forward migration dropping `referrals` and the two `entitlements` columns.
  Rolling back the code alone is safe.

Read back:

```sql
SELECT u.email, e.product, e.source, e.starts_at, e.expires_at
  FROM entitlements e JOIN "User" u ON u.id = e.subject_id
 WHERE e.subject_kind = 'user' ORDER BY e.created_at DESC LIMIT 5;
SELECT provider_event_id, type, processed_at, error,
       count(*) OVER (PARTITION BY provider, provider_event_id) AS times
  FROM payment_events WHERE provider = 'revenuecat'
 ORDER BY received_at DESC LIMIT 10;
```

