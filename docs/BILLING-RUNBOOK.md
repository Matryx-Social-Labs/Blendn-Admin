# Billing runbook (Razorpay)

What to do when money and the dashboard disagree. The design is in
`lib/razorpay-webhook.ts`; this is the operator's half.

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
`payment.captured`, `payment.failed`, `order.paid`, `refund.processed`,
`payment.dispute.created`, `payment.dispute.lost`, `payment.dispute.won`.
Then run `npx tsx scripts/razorpay-plans.ts --apply` once with that
environment's keys (dry run without `--apply`).

`payment_link.paid` (sponsor payment links) is step 17's and is not handled
yet: a delivery of it is recorded and changes nothing.

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
