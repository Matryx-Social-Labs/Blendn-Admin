# Razorpay website verification: what Razorpay checks, and where we stand

Audit of 26 October 2026, for moving the Razorpay account from test mode to
live. What to paste into Razorpay's form is `docs/RAZORPAY-SUBMISSION.md`.

## What Razorpay asks for

From Razorpay's own documentation, read on 26 October 2026:

- **Business website details** ([docs](https://razorpay.com/docs/payments/dashboard/account-settings/business-website-details/)).
  - Required pages: About us, Contact us, Pricing details, Terms and conditions,
    Privacy policy, and a Refunds policy ("Cancellation/Refund policy" for
    additional websites).
  - A sample invoice (PNG, JPG or PDF).
  - Test account credentials when "your website requires login from user to
    complete payment".
  - The primary website gets instant automated checks of the site, its policy
    pages and the business industry. Additional websites are reviewed by hand.
  - Without these, Razorpay does not issue live API keys.
- **International payments** ([docs](https://razorpay.com/docs/payments/international-payments/),
  [Razorpay's guide](https://razorpay.com/learn/breaking-down-the-requirements-for-accepting-international-payments-through-razorpay/)).
  - KYC complete, plus a website with Terms, Privacy, Refund and Cancellation,
    and Shipping policies. Razorpay says international payments "cannot be
    enabled" without them.
  - The Contact page must show the registered name, a registered and operating
    address that Google can verify, a phone number and an email.
  - The shipping policy is mandatory: for a digital service, it says how the
    service is delivered.
  - About us gives the registered name, the business and how long it has
    operated.
  - Activation is a separate form: Account & Settings → International payments.
    Settlement is in INR.
- **The legal name** must match KYC: Matryx Social Labs Private Limited.

## The audit

Website submitted: **https://dashboard.blendn.app**. It is the one site that
sells anything; www.blendn.app sells nothing and has no checkout.

| Requirement | Where it is now (this branch) | Gap before | Fix |
|---|---|---|---|
| Pricing details | `/pricing`, public. Read from `lib/billing-plans.ts`, the table checkout charges from: Event Pass ₹589, Analytics ₹2,359/month or ₹23,588/year, Venue Pro ₹3,539/month or ₹35,388/year, all GST included and split out. Sponsor placements by agreement; Blend'n+ is the stores'. | Prices only on `/dashboard/plan`, behind sign-in | New page |
| About us | `/about` | None | New page. It does not state how long the company has operated: the owner adds a founding year if wanted. |
| Contact us | `/contact`: legal name, registered and operating address, phone +91 81972 83344, contact@matrixsociallabs.com, privacy@, the grievance officer | None on the dashboard. The Terms had the phone and email at the bottom. | New page, plus a seller block (legal name, address, email, phone) at the foot of every policy page |
| Terms and conditions | `/terms`, rendered from `docs/legal/terms-of-use.html`, plus a new §32 "Paid plans and payments" | Not served anywhere: the file was only in `docs/`. www.blendn.app has no terms page. | Served from the one file. Fixed its Community Guidelines link (pointed at a 404, `blendn.app/community`). |
| Privacy policy | `/privacy` redirects to https://www.blendn.app/privacy (28 September 2026, the version the app links to) | Not reachable from the dashboard. `docs/legal/privacy-policy.html` is the March draft and predates the 180-day retention, so it is **not** served. | Redirect. Delete or sync the stale `docs/legal/privacy-policy.html` later. |
| Cancellation and refund policy | `/refunds`: plan cancels, the Event Pass, full-refund cases, sponsor payment links, how and when (5 to 7 business days through Razorpay), Blend'n+ refunded by Apple or Google, disputes | None anywhere | New page, written from what the billing code does (`cancelAnalytics`, docs/BILLING-RUNBOOK.md) |
| Shipping and delivery policy | `/shipping`: digital only, nothing shipped, access on payment confirmation (usually within a minute), what to do after 24 hours | None anywhere | New page |
| Legal name matching KYC | "Matryx Social Labs Private Limited" on every policy page footer, the Terms, Contact and About; the Plan page's Payments panel already said it | The brand "Matrix Social Labs" was on www's footer only | `lib/company.ts` holds it once |
| Working navigation | Every policy page links all seven plus Sign in. The sign-in page's footer links all seven. All answer 200 signed out (`/privacy` 307 to www). | — | `middleware.ts` matcher does not cover them: `__tests__/policy-pages-public.test.ts` |
| Test login for gated areas | `scripts/seed-razorpay-review.ts` (`npm run seed:razorpay-review`): `razorpay.review@blendn.app`, an organizer who owns its own demo organisation, with one draft event. The server refuses that organisation any publish, venue add or link, and invite (`lib/review-demo-org.ts`); the mobile app refuses an organizer's sign-in. The script never takes over an account it did not make. | No such account; the staging test accounts refuse production by design | New script. The owner runs it on production. |
| Sample invoice | Razorpay issues invoices (the Plan page says so) | None on file | **Owner action:** upload a sample invoice from Razorpay Invoices, or a PDF made there, under the legal name and GSTIN |
| Checkout reachable by the reviewer | Plan page → "Start Analytics" opens Razorpay Checkout when keys are set | **Production has no Razorpay keys**, so the Plan page there says "Payments aren't switched on here yet". **Staging's test keys are refused by Razorpay** (HTTP 401 on 26 October 2026, from a key id of the right shape): checkout fails on staging too. | **Owner action:** regenerate the test-mode keys and set them on staging. See the submission doc for which site to give the reviewer. |
| International (CAD) | Nothing charges CAD: INR is hardcoded in `lib/razorpay.ts` and the Plan page. The CAD price pack the owner approved on 19 October 2026 is not built. | — | Not fixed here. `/pricing` shows INR only, because showing a CAD price the checkout cannot charge would be wrong. Apply for international once CAD is built (`docs/RAZORPAY-SUBMISSION.md` § International). |

### www.blendn.app (read-only here, `blendnlanding` origin/main)

Pages: home, `/privacy`, `/community-guidelines`, `/delete-account`. The
footer shows "A product of Matrix Social Labs" and links Privacy, Community
guidelines and Delete account. It has no terms, pricing, contact, refund or
shipping page, and no legal name in the footer. It does not need them while
the submitted website is the dashboard. If the owner ever submits www instead,
or Razorpay asks, link the dashboard's seven pages from www's footer and put
the legal name there: a change in the landing repo.

### Not changed, worth knowing

- The Terms of Use are a generated template (Termly). §18 sends disputes to
  the "European Arbitration Chamber (Belgium)" with a Bengaluru seat. Left as
  it is: OWNER/LAWYER REVIEW. The usual Indian alternative is arbitration
  under the Arbitration and Conciliation Act 1996, seat and venue Bengaluru,
  one arbitrator. The registered address's "kithore Rani chennamma road" was a
  typo, now "Kittur Rani Chennamma Road" in the Terms and the March privacy draft.
