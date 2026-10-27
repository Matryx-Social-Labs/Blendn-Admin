# What to paste into Razorpay's website verification

For the owner. The audit behind it is `docs/RAZORPAY-VERIFICATION.md`. Razorpay
Dashboard → Account & Settings → Business website details.

## Before submitting (in this order)

1. Merge this branch and deploy it to production. Check
   https://dashboard.blendn.app/pricing opens without signing in.
2. Choose the reviewer's password and set it where you can find it again. The
   password is **not** stored in Railway: it is only needed when the script
   runs. Keep it in your password manager under "Razorpay reviewer". It must
   pass the product's password rule: no "blendn" in it, and not a common
   password.
3. Create the account on production. You run this, or approve it being run:

   ```bash
   # Typed, not pasted into the command line: neither lands in shell history.
   # DATABASE_PUBLIC_URL is on the production Postgres service (Railway → Postgres → Variables).
   read -s DATABASE_URL; export DATABASE_URL
   npx tsx scripts/seed-razorpay-review.ts --production            # dry run: says what it would make
   read -s RAZORPAY_REVIEW_PASSWORD; export RAZORPAY_REVIEW_PASSWORD
   npx tsx scripts/seed-razorpay-review.ts --apply --production
   unset RAZORPAY_REVIEW_PASSWORD DATABASE_URL
   ```

   It prints the email and the ids, never the password. It refuses, writing
   nothing, if `razorpay.review@blendn.app` already belongs to an account it did
   not create, or one an admin has suspended or changed the role of. Sign in once at
   https://dashboard.blendn.app/login with them to check.
4. Get a sample invoice from Razorpay (Invoices → create one in test mode under
   the legal name and GSTIN), saved as PDF.

## The form

| Field | Answer |
|---|---|
| Website URL | `https://dashboard.blendn.app` |
| About us | `https://dashboard.blendn.app/about` |
| Contact us | `https://dashboard.blendn.app/contact` |
| Pricing details | `https://dashboard.blendn.app/pricing` |
| Terms and conditions | `https://dashboard.blendn.app/terms` |
| Privacy policy | `https://dashboard.blendn.app/privacy` (opens the policy at www.blendn.app/privacy). If the form refuses a redirect, give `https://www.blendn.app/privacy`. |
| Cancellation / refund policy | `https://dashboard.blendn.app/refunds` |
| Shipping / delivery policy | `https://dashboard.blendn.app/shipping` |
| Sample invoice | the PDF from step 4 |
| Does your website require login from user to complete payment? | **Yes** |
| Test username | `razorpay.review@blendn.app` |
| Test password | the password from step 2 (from your password manager; never in a ticket, a chat or this file) |

**Business description** (paste as is):

> Blend'n is an event networking platform run by Matryx Social Labs Private
> Limited, Bengaluru. Attendees use the free Blend'n mobile app to check in at
> events and meet the people there. Event organizers, venues and brand sponsors
> use the Blend'n dashboard (dashboard.blendn.app), a web application, to run
> their events. Using the dashboard is free; we sell optional software
> subscriptions on it: Analytics for organizers (₹1,999 a month or ₹19,990 a
> year before GST), an Event Pass for one event's analytics (₹499 before GST),
> and Venue Pro for venues (₹2,999 a month or ₹29,990 a year before GST), plus
> sponsored placements for brands, paid through Razorpay payment links at
> agreed prices. Everything sold is a digital service delivered to the
> customer's dashboard account on payment; nothing is shipped. In-app purchases
> in the mobile app are sold through the App Store and Google Play, not through
> Razorpay.

**Note for the reviewer** (if there is a notes field):

> Sign in at https://dashboard.blendn.app/login with the test account. It is an
> organizer account with its own demo organisation and one draft event; it sees
> no real users' data, and it cannot publish events, add venues or invite
> anyone; its events stay drafts. The paid plans are on the Plan page (left menu → Plan):
> Analytics monthly or yearly, and the Event Pass. Checkout opens Razorpay
> Checkout once live keys are issued; until then the page says payments are not
> switched on yet. Every policy page is linked at the foot of the sign-in page.

If Razorpay asks to see Checkout working before live keys: staging runs the
same code in test mode, at `https://staging-dashboard.blendn.app`. That needs
step "Fix staging's test keys" below first, then the same script run against
staging (no `--production`), and the same email with a password you give them.

## International payments (CAD)

Razorpay asks for this separately: Account & Settings → International payments
→ Activate. The website side is already covered by the pages above (Terms,
Privacy, Refund, Shipping, Contact with the address and phone).

**Recommendation: apply for domestic live mode first, and international
later.** Nothing charges CAD yet: INR is hardcoded in `lib/razorpay.ts` and the
Plan page, and the Canada price pack you approved on 19 October 2026 (Analytics
CA$59, Event Pass CA$15, Venue Pro CA$79) is not built. When it is, the
answers are:

| Question | Answer |
|---|---|
| Products sold abroad | Software subscriptions for event organizers and venues in Canada (digital, no shipping) |
| Currencies | CAD |
| Payment methods | International cards |
| Expected monthly volume | your estimate |
| Settlement | INR to the current account (Razorpay settles international payments in INR) |
| Export documents | FIRC is issued by Razorpay automatically; a GST letter of undertaking (LUT) is filed for zero-rated exports (your CA confirms before the first CAD charge) |

## After approval (in this order)

1. **Live keys on production.** Railway → production → Blendn-Admin:
   `RAZORPAY_KEY_ID` (`rzp_live_…`), `RAZORPAY_KEY_SECRET`, and
   `RAZORPAY_WEBHOOK_SECRET` (32+ characters, chosen by you). A test key in
   production refuses to boot, by design.
2. **Register the live webhook** at `https://<api host>/api/webhooks/razorpay`
   with the events listed in `docs/BILLING-RUNBOOK.md` § Setup, and the same
   secret.
3. **Create the plans at Razorpay:** `npx tsx scripts/razorpay-plans.ts` (dry
   run), then `--apply`, with production's live keys.
4. **Take the reviewer account down** once Razorpay no longer needs it:

   ```bash
   read -s DATABASE_URL; export DATABASE_URL
   npx tsx scripts/seed-razorpay-review.ts --remove --apply --production
   unset DATABASE_URL
   ```

   Every event of the demo organisation is deleted (soft: an Event Pass or
   payment keeps pointing at it), any venue it added is retired, the
   organisation is suspended and the account closed.

## Fix staging's test keys (found 26 October 2026)

Staging's `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` are refused by Razorpay
with HTTP 401 ("Authentication failed"), so "Start Analytics" fails there with
"Razorpay didn't accept that just now". Regenerate the test-mode key pair in
Razorpay (Test mode → Account & Settings → API keys) and set both on Railway
staging, then run `npx tsx scripts/razorpay-plans.ts --apply` against staging
once.
