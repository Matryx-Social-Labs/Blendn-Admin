# In-app purchases: setting up Blendn+ (App Store, Google Play, RevenueCat)

Verified on 2026-10-10 against the primary docs linked in each section; an
unconfirmed screen label says "(label may differ)". Plan decision D7. Server
half: `lib/revenuecat-webhook.ts`, `app/api/webhooks/revenuecat/route.ts`.

## Short answer

**You do not need an approved app first.** Two orderings you cannot skip:

- **Google:** a build containing Play Billing must already be on a testing
  track (internal is enough) **before** the console lets you create
  subscriptions. ([Play Billing: getting ready](https://developer.android.com/google/play/billing/getting-ready))
- **Apple:** the first auto-renewable subscription, and the first non-renewing
  one (the Night Pass), go to review **together with an app version**. After
  the first of a type is approved, later ones of that type can go on their own.
  ([Apple: submit an in-app purchase](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-in-app-purchase))

Razorpay is never used for Blendn+ in the app: Blendn+ unlocks features inside
the app, so Guideline 3.1.1 requires Apple's in-app purchase, and Play Billing
on Android. ([App Review Guidelines 3.1.1](https://developer.apple.com/app-store/review/guidelines/#in-app-purchase))

## The fixed names

| Thing | Apple | Google |
|---|---|---|
| Monthly ₹199 | `blendn_plus_monthly` (auto-renewable, group "Blendn+") | `blendn_plus`, base plan `monthly` |
| Quarterly ₹499 | `blendn_plus_quarterly` | `blendn_plus`, base plan `quarterly` |
| Yearly ₹1,499 | `blendn_plus_yearly` | `blendn_plus`, base plan `yearly` |
| Night Pass ₹49 (24 h, buy again any time) | `blendn_night_pass` (non-renewing subscription) | `blendn_night_pass` (one-time, consumable) |

App "Blend'n", bundle id and package `com.matryxsociallabs.blendn`, App Store
Connect app id 6757761059. RevenueCat names the Google plans
`blendn_plus:monthly` etc. Product IDs can never be changed or reused, on either
store. ([Play: create a subscription](https://support.google.com/googleplay/android-developer/answer/140504))

## Who does what, in order

| # | Who | Step | Section |
|---|---|---|---|
| 1 | Owner (Account Holder) | Apple: sign the Paid Apps Agreement; banking; tax | [A1](#a1-agreements-banking-tax) |
| 2 | Owner | Google: payments profile, GSTIN | [G1](#g1-payments-profile) |
| 3 | Owner | Apple Small Business Program; Google 15% tier | [A2](#a2-small-business-program), [G2](#g2-15-service-fee-tier) |
| 4 | Engineer | Build containing `react-native-purchases` to TestFlight + Play internal (`npm run ship:local`) | [App](#app-eas) |
| 5 | Owner | Create the Apple products | [A3](#a3-products) |
| 6 | Owner | Create the Google products | [G3](#g3-products) |
| 7 | Owner + engineer | RevenueCat project, apps, store credentials | [RevenueCat](#revenuecat) |
| 8 | Owner | RevenueCat products, entitlement `plus`, offering `default` | [RevenueCat](#revenuecat) |
| 9 | Owner + engineer | Apple server notifications; Google service account + real-time notifications | [A4](#a4-keys-and-server-notifications), [G4](#g4-service-account-and-real-time-notifications-engineer) |
| 10 | Engineer | Two RevenueCat webhooks; `REVENUECAT_WEBHOOK_SECRET` on Railway | [Server](#server-railway) |
| 11 | Engineer | EAS env vars (public SDK keys); rebuild and ship | [App](#app-eas) |
| 12 | Owner | Apple sandbox testers; Google licence testers on the internal track | [Testing](#testing) |
| 13 | Owner + engineer | One sandbox purchase per store; read the rows back | [Testing](#testing) |
| 14 | Engineer | Review prep: `appreview@blendn.app` grant, paywall disclosures, notes, screenshots | [App Review](#app-review) |
| 15 | Owner | Apple: submit the version with all four products attached | [App Review](#app-review) |
| 16 | Owner | Google: promote the release to production | [App Review](#app-review) |
| 17 | Owner, later | Gate a city: set `PLUS_GATING` on Railway, redeploy | [Server](#server-railway) |

## App Store Connect

### A1. Agreements, banking, tax

**Business** → **Agreements** tab → **Paid Apps** row → **View and Agree to
Terms** → **Agree** (Account Holder only); then banking and tax in the same
area. Until the agreement is active **and** its latest version signed, no
product loads, not even in the sandbox. Apple re-issues it from time to time:
when products suddenly come back empty, look here first.
([Apple: agreements](https://developer.apple.com/help/app-store-connect/manage-agreements/sign-and-update-agreements), [Apple: prepare for sandbox testing](https://developer.apple.com/documentation/storekit/testing-in-app-purchases-with-sandbox), [RevenueCat: troubleshooting offerings](https://www.revenuecat.com/docs/offerings/troubleshooting-offerings))

### A2. Small Business Program

Enrol as Account Holder at [the enrolment page](https://developer.apple.com/app-store/small-business-program/enroll/),
listing any associated developer accounts: 15% commission while proceeds stay
under $1M a year. It starts 15 days after the end of the fiscal month Apple
approves you in, so enrol before launch. ([Apple: Small Business Program](https://developer.apple.com/app-store/small-business-program/))

### A3. Products

Apps → Blend'n, then:

1. Sidebar **Monetization** → **Subscriptions** → **(+)** → reference name
   `Blendn+` → **Create**. In the group: **Display Name and Description** →
   **Add** → app's primary language, display name `Blendn+` → **Add**.
2. In the group → **Create** → reference name `Blendn+ Monthly`, Product ID
   `blendn_plus_monthly` → **Create**. **Subscription Duration** 1 Month →
   **Save**; **Subscription Prices** India ₹199 (nearest point if not offered;
   let Apple fill other storefronts or limit **Availability**); **Display Name
   and Description** → **Add**; **Review Information**: paywall screenshot
   (engineer supplies) and notes. Family Sharing off. **Save**.
3. Repeat: `blendn_plus_quarterly` (3 Months, ₹499), `blendn_plus_yearly`
   (1 Year, ₹1,499).
4. Night Pass: **Subscriptions** → scroll to **Non-Renewing Subscriptions** →
   **Manage** → **(+)** → `Night Pass` / `blendn_night_pass` → **Create** →
   ₹49, localisation, review screenshot → **Save**. No duration field: our
   server grants the 24 h.
5. Each product should read **Prepare for Submission** with no missing-metadata
   warning (older docs and RevenueCat's say "Ready to Submit"; Apple's current
   status list has no such name). Changes take up to an hour to reach the
   sandbox. Do **not** press **Add for Review** yet: that is step 15.

([Apple: auto-renewable subscriptions](https://developer.apple.com/help/app-store-connect/manage-subscriptions/offer-auto-renewable-subscriptions), [non-renewing](https://developer.apple.com/help/app-store-connect/manage-in-app-purchases/create-non-renewing-subscriptions), [statuses](https://developer.apple.com/help/app-store-connect/reference/in-app-purchases-and-subscriptions/in-app-purchase-statuses), [RevenueCat: iOS products](https://www.revenuecat.com/docs/getting-started/entitlements/ios-products))

### A4. Keys and server notifications

1. **In-App Purchase key** (RevenueCat verifies purchases with it): **Users and
   Access** → **Integrations** → **In-App Purchase** → generate; download the
   `.p8` (once only), note Key ID and Issuer ID.
2. **App Store Connect API key** (RevenueCat imports products with it): same
   place → **App Store Connect API** → new key, **App Manager** access →
   `.p8` + Issuer ID; also the **Vendor number** (Payments and Financial
   Reports). Both `.p8` files live in the password manager, never in git.
3. Once RevenueCat is set up, press **Apply in App Store Connect** on its App
   Store app, or by hand: **App Information** → **App Store Server
   Notifications** → RevenueCat's URL as both Production and Sandbox URL,
   **Version 2**. Apple notifies RevenueCat; RevenueCat calls us.

The app-specific shared secret is for StoreKit 1 only; add it only if asked.
([RevenueCat: In-App Purchase key](https://www.revenuecat.com/docs/service-credentials/itunesconnect-app-specific-shared-secret/in-app-purchase-key-configuration), [ASC API key](https://www.revenuecat.com/docs/service-credentials/itunesconnect-app-specific-shared-secret/app-store-connect-api-key-configuration), [Apple notifications](https://www.revenuecat.com/docs/platform-resources/server-notifications/apple-server-notifications), [shared secret](https://www.revenuecat.com/docs/service-credentials/itunesconnect-app-specific-shared-secret))

## Play Console

### G1. Payments profile

**Settings** → **Payments profile** → **Create payments profile**, legal name
"Matryx Social Labs Private Limited". Add the GSTIN in Google Payments Centre →
**Settings** → **India tax info** → Edit. [India tax](#india-tax-gst) explains
why this matters more on Google.
([Play: payments profile](https://support.google.com/googleplay/android-developer/answer/7161426), [Payments: India](https://support.google.com/paymentscenter/answer/7421525?hl=en-IN))

### G2. 15% service fee tier

Subscriptions are 15% regardless. The Night Pass (one-time) is 15% only if you
enrol: **Associated Developer Accounts** → create the Account Group → **Review
and enroll** → **Accept and enroll**.
([Play: service fees](https://support.google.com/googleplay/android-developer/answer/112622), [15% tier](https://support.google.com/googleplay/android-developer/answer/10632485))

### G3. Products

Needs step 4 first (a build with Play Billing on the internal track).

1. **Monetize with Play** → **Products** → **Subscriptions** → **Create
   subscription** → `blendn_plus`, name `Blendn+`.
2. **Add base plan** → `monthly`, Auto-renewing, monthly, ₹199 → **Activate**;
   then `quarterly` (every 3 months, ₹499) and `yearly` (₹1,499). Grace period
   and account hold: defaults. (labels may differ)
3. **Products** → **One-time products** (older: **In-app products**) →
   **Create** → `blendn_night_pass`, title, description, ₹49 → **Activate**.
   "Consumable" is not a console setting: RevenueCat consumes a Play one-time
   purchase unless marked non-consumable in RevenueCat, so it can be rebought.

([Play Billing: getting ready](https://developer.android.com/google/play/billing/getting-ready), [base plans and offers](https://support.google.com/googleplay/android-developer/answer/12154973), [one-time products](https://support.google.com/googleplay/android-developer/answer/1153481), [RevenueCat: Android products](https://www.revenuecat.com/docs/getting-started/entitlements/android-products))

### G4. Service account and real-time notifications (engineer)

1. Google Cloud: enable **Google Play Android Developer API**, **Google Play
   Developer Reporting API**, **Cloud Pub/Sub**; a service account with
   **Pub/Sub Editor** (**Pub/Sub Admin** on permission errors) and **Monitoring
   Viewer**; a JSON key. RevenueCat's docs carry a script that does all this.
2. Play Console → **Users and permissions** → invite its email with: *View app
   information and download bulk reports (read-only)*; *View financial data,
   orders, and cancellation survey responses*; *Manage orders and
   subscriptions*; *Manage store presence*.
3. Upload the JSON to the Play Store app in RevenueCat. **New credentials can
   take up to 36 hours to work**: do this early.
4. RevenueCat Play Store app → **Connect to Google** → copy the topic → Play
   Console → **Monetize with Play** → **Monetization setup** → **Topic name**;
   content **Subscriptions, voided purchases, and all one-time products** →
   Save → **Send test notification**. If it fails, give
   `google-play-developer-notifications@system.gserviceaccount.com` **Pub/Sub
   Publisher** on the topic.

([RevenueCat: Play credentials](https://www.revenuecat.com/docs/service-credentials/creating-play-service-credentials), [Google notifications](https://www.revenuecat.com/docs/platform-resources/server-notifications/google-server-notifications))

## RevenueCat

1. **Project:** Projects dropdown → **+ Create new project** → `Blendn`.
2. **Apps** (label may differ, e.g. "Apps & providers"): an **App Store** app
   (bundle id; In-App Purchase key, Key ID, Issuer ID; on its **App Store
   Connect API** tab the API key, Issuer ID, Vendor number) and a **Play
   Store** app (package; the service-account JSON).
3. **Public SDK keys:** **Project settings** → **API keys**: `appl_…` and
   `goog_…`. These go in the app. A secret key (`sk_…`) never does; we need none.
4. **Products:** **Product catalog** → **Products** → **+ New** → **Import
   Products**, or by hand with the IDs above. Leave `blendn_night_pass` on Play
   as consumable (do not mark it non-consumable).
5. **Entitlement:** **Entitlements** → **+ New entitlement** → `plus` →
   **Attach** the three Apple subscriptions and the three `blendn_plus:` plans.
   **Not the Night Pass:** RevenueCat treats a non-renewing or one-time product
   on an entitlement as unlocked for ever; our server grants the 24 h.
6. **Offering:** **Offerings** → **+ New** → `default`, made the default
   offering → **+ Add package** for each:

   | Package | App Store / Play |
   |---|---|
   | `$rc_monthly` | `blendn_plus_monthly` / `blendn_plus:monthly` |
   | `$rc_three_month` | `blendn_plus_quarterly` / `blendn_plus:quarterly` |
   | `$rc_annual` | `blendn_plus_yearly` / `blendn_plus:yearly` |
   | `night_pass` (custom) | `blendn_night_pass` / `blendn_night_pass` |

7. **Restore behaviour** (**Project settings** → **General**): keep the default,
   **Transfer to new App User ID**. If a second Blendn account restores or buys
   on the same Apple ID or Google account, the purchase moves to it and the
   first loses it; RevenueCat sends `TRANSFER` and our server moves the grant.
   The app calls `Purchases.logIn(<our user id>)` at sign-in, `logOut` at
   sign-out, and never sells while anonymous.
   **What this decides:** whoever signs in to Blendn on a phone using the
   Apple ID or Google account that paid can move Blendn+ to their account by
   restoring. That is the stores' rule (the purchase belongs to the store
   account) and RevenueCat's documented default. The server moves it only
   between two of our real accounts named in a verified webhook — never to an
   anonymous or deleted one — and writes an `entitlement.transferred` audit row
   for every move. The alternative, **Keep with original App User ID**, stops
   the move but leaves a person who changes Blendn account unable to restore
   what they paid for; it is the owner's call, and the default is recommended.

([projects](https://www.revenuecat.com/docs/projects/overview), [connect a store](https://www.revenuecat.com/docs/projects/connect-a-store), [API keys](https://www.revenuecat.com/docs/projects/authentication), [products](https://www.revenuecat.com/docs/offerings/products-overview), [entitlements](https://www.revenuecat.com/docs/getting-started/entitlements), [non-subscriptions](https://www.revenuecat.com/docs/platform-resources/non-subscriptions), [offerings](https://www.revenuecat.com/docs/offerings/overview), [restore behaviour](https://www.revenuecat.com/docs/projects/restore-behavior))

## Server (Railway)

**Webhooks (engineer).** One secret per environment, `openssl rand -hex 32`
(64 characters; the server requires 32+). RevenueCat → **Integrations** →
**Webhooks** → **Add new configuration**, twice:

| Field | Staging | Production |
|---|---|---|
| Webhook URL | `https://staging-api.blendn.app/api/webhooks/revenuecat` | `https://api.blendn.app/api/webhooks/revenuecat` |
| Authorization header value | `Bearer <staging secret>` | `Bearer <production secret>` |
| Environment | Sandbox only | Production only |
| App / event filter | all apps / none (all events) | all apps / none (all events) |

Railway, each environment's admin service → **Variables** →
`REVENUECAT_WEBHOOK_SECRET` = the bare secret (no `Bearer `) → redeploy. Unset:
every delivery gets a 401, so Blendn+ is off. The server reads its environment
from `RAILWAY_ENVIRONMENT_NAME`: `production` grants only PRODUCTION events,
every other environment only SANDBOX; the rest is recorded, never granted.

Then press the webhook's test-event button. A test event is type `TEST`,
environment SANDBOX; the server records it and changes nothing, so a
`payment_events` row of type `TEST` with no `error` proves URL and header.
RevenueCat retries a non-2xx five times (5, 10, 20, 40, 80 minutes).
([RevenueCat: webhooks](https://www.revenuecat.com/docs/integrations/webhooks), [event types](https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields))

**Gating a city (owner, later).** `PLUS_GATING` unset or `false`: launch season
everywhere, everything free. `true`: gated everywhere. A comma list of cities
(case-insensitive, as written on venues), e.g. `Bengaluru`: only those. To gate
a city, set it on Railway and redeploy. **Nothing else to run.** The server
grants the 14-day trial itself, once per person ever, the first time someone
who has come out at least once in the last 90 days meets a Blendn+ gate in a
gated city, and at that moment pays out any banked referral month (3 invited
friends who checked in = 1 month).

## App (EAS)

1. **Build (step 4, engineer).** `react-native-purchases` brings Play Billing
   and the BILLING permission; ship with `npm run ship:local`. Google requires
   Play Billing Library 8+ for updates since 31 Aug 2026 (extension to
   1 Nov 2026): check what the SDK bundles. ([Play Billing: getting ready](https://developer.android.com/google/play/billing/getting-ready))
2. **Keys (step 11).** expo.dev → project → **Project settings** →
   **Environment variables** → **Add Variables**, or
   `eas env:set --name EXPO_PUBLIC_REVENUECAT_APPLE_KEY --value appl_… --environment production --visibility plaintext`
   (older eas-cli: `eas env:create`). Set `EXPO_PUBLIC_REVENUECAT_APPLE_KEY`
   (`appl_…`) and `EXPO_PUBLIC_REVENUECAT_GOOGLE_KEY` (`goog_…`) in
   `development`, `preview`, `production`; visibility **plaintext** or
   **sensitive**, never **secret** (`EXPO_PUBLIC_` values are built into the
   app, and local builds don't receive secret ones). Unset = purchases off; the
   paywall says they aren't available yet.
3. Values are baked in at build time: **rebuild and ship** after setting them,
   and check no local `.env*` in the client checkout overrides them.

([Expo: environment variables](https://docs.expo.dev/eas/environment-variables/), [manage](https://docs.expo.dev/eas/environment-variables/manage/), [local builds](https://docs.expo.dev/build-reference/local-builds/), [RevenueCat: Expo](https://www.revenuecat.com/docs/getting-started/installation/expo))

## Testing

**iOS, TestFlight (simplest).** TestFlight purchases always run in the sandbox,
free, even with your own Apple Account, and reach the **staging** webhook. For
sandbox controls (renewal rate, clear history): **Users and Access** →
**Sandbox** → **(+)**, an email that is not an Apple Account, India storefront;
on the phone sign out of **Media & Purchases**, then **Settings** → **Developer**
→ **Sandbox Apple Account** → **Sign In** (needs Developer Mode).
([Apple: sandbox](https://developer.apple.com/documentation/storekit/testing-in-app-purchases-with-sandbox), [sandbox account](https://developer.apple.com/help/app-store-connect/test-in-app-purchases/create-a-sandbox-apple-account))

**iOS simulator.** Products load only with a StoreKit Configuration file, and
only when launched from Xcode's Run (our `xcodebuild` + `simctl` loop ignores
it); RevenueCat validates these only with the StoreKit test certificate
uploaded. Good for the paywall's look, not for the webhook or the database.
([RevenueCat: Apple sandbox](https://www.revenuecat.com/docs/test-and-launch/sandbox/apple-app-store))

**Android.** Tester under **Settings** → **License testing**, the same account
on the internal track's testers, opt-in link opened (without it products don't
load). Install from Play, pay with **Test card, always approves** (free for
licence testers). Renewals: monthly 5 min, 3-monthly 10 min, yearly 30 min, at
most 6. Internal-track purchases have spend limits. RevenueCat's guide says
*closed* track; Google's accepts any, internal included: if products stay empty
on internal, push the same build to closed. Needs a real phone or an emulator
image with the Play Store; our AVD has none.
([Play: test Play Billing](https://developer.android.com/google/play/billing/test), [RevenueCat: Play sandbox](https://www.revenuecat.com/docs/test-and-launch/sandbox/google-play-store))

**Read back** (staging database). Pass: a new `entitlements` row, `source`
`apple`/`google`, `product` `plus`/`night_pass`, `expires_at` minutes ahead for
a sandbox subscription or 24 h for a Night Pass (a second pass runs from the end
of the first); its `payment_events` row has `processed_at` set, `error` empty.

```sql
SELECT u.email, e.product, e.source, e.starts_at, e.expires_at FROM entitlements e JOIN "User" u ON u.id = e.subject_id WHERE e.subject_kind = 'user' ORDER BY e.created_at DESC LIMIT 5;
SELECT provider_event_id, type, processed_at, error FROM payment_events WHERE provider = 'revenuecat' ORDER BY received_at DESC LIMIT 10;
```

## App Review

Apple's reviewers buy in the sandbox against the production app. Production
refuses sandbox events; the purchase reaches only the staging webhook, where
that user is unknown (`unknown_user`). So the review account is granted Plus in
advance. ([RevenueCat: App Store rejections](https://www.revenuecat.com/docs/test-and-launch/app-store-rejections))

1. **Engineer:** while production has no `PLUS_GATING` (launch season, which
   is how Blendn+ launches), every Plus feature is already open to the
   reviewer and no grant is needed. Once a city is gated, grant
   `appreview@blendn.app` Plus on **production** (`source = 'grant'`). There is
   no dashboard control for a person's Plus yet (SCRUM-583); until there is,
   keep the review account's city ungated or ask for the control first — never
   write `entitlements` by hand. Either way, check the account passes the 18+
   gate **and can still open the paywall and buy**: Guideline 2.1(b) wants
   every product visible and working for the reviewer.
2. **Engineer and designer, the paywall shows:** each subscription's name,
   length and what Plus gives; the full renewal price, the billed amount the
   most prominent (₹1,499/year above any "₹125/month"); **Restore purchases**;
   working links to the **Privacy Policy** and **Terms of Use (EULA)**. The
   listing needs the Privacy Policy URL field, and the Terms link in the
   description or the custom EULA field. Auto-renewable periods must be 7 days
   or more (ours are). A store trial, if ever added, must state its length,
   what ends, and the charge after.
3. **Owner:** version page → **App Review Information**: the account's sign-in
   and notes such as:

   > Blendn+ is sold by in-app purchase: three auto-renewable subscriptions in
   > the group "Blendn+" and Night Pass, a non-renewing 24-hour pass. Sign in
   > as appreview@blendn.app; the paywall is at <path>. Purchases in the review
   > sandbox are not credited by our production server; during our launch
   > season every Blendn+ feature is open to all accounts, so you can review
   > them directly. (Once a city is gated: "this account already has Blendn+".)

4. **Owner:** attach the three subscriptions and the Night Pass (each product →
   **Add for Review** → choose the version; or the version page's in-app
   purchases section, label may differ) → **Submit for Review**. After
   approval allow up to 24 h before products work live.
5. **Google:** products are already active; promote the tested release from
   internal to production (label may differ).

([Guidelines 2.1, 3.1.1, 3.1.2](https://developer.apple.com/app-store/review/guidelines/), [Apple: subscriptions](https://developer.apple.com/app-store/subscriptions/), [Apple: submit an in-app purchase](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-in-app-purchase))

## India tax (GST)

The two stores differ for a company based in India.

- **Apple collects and remits GST** on sales to customers in India: India is on
  Exhibit B's collect-and-remit list with no "non-resident developers only"
  mark. Proceeds arrive net of it.
  ([Exhibits to Schedules 2 and 3, 27 Aug 2026, Exhibit B](https://developer.apple.com/support/downloads/terms/exhibits/Exhibits-to-Schedule-2-and-3-English.pdf))
- **Google does not, for a developer located in India** (only for developers
  outside India). Matryx Social Labs registers for GST and remits it on Play
  sales itself; the Play price is GST-inclusive. Google, as marketplace,
  deducts withholding tax and GST TCS; GST on Google's service fee is ours.
  ([Play: tax rates](https://support.google.com/googleplay/android-developer/answer/138000), [Payments: India](https://support.google.com/paymentscenter/answer/7421525?hl=en-IN))

Confirm in each console's tax section, and with the company's CA, before the
first paid sale.

## Troubleshooting

| Symptom | Usual cause |
|---|---|
| iOS paywall empty | Paid Apps Agreement not active or not the latest; banking/tax incomplete; metadata incomplete; ID typo; change under an hour old; simulator without a StoreKit file |
| Android paywall empty | Build not on a track; tester not opted in or not a licence tester; product/base plan not active; credentials under 36 h old; RevenueCat ID not `blendn_plus:<plan>` |
| "Purchases aren't available yet" | That build's EAS environment has no `EXPO_PUBLIC_REVENUECAT_*` key |
| Webhook 401 | Header not exactly `Bearer <secret>`; secret unset or the other environment's; not redeployed. Repeated failures are rate-limited per network |
| Webhook 500 | Database failure; RevenueCat's retry applies it |
| Bought, no Plus | Read `payment_events.error` (below) |

`payment_events.error`: `unknown_user` (not one of our people: an anonymous
RevenueCat id, a deleted account, or a user of the other database, such as the
reviewer's sandbox purchase on staging); `wrong_environment` (sandbox on
production, or real elsewhere); `unsupported_store` (not App Store or Play, e.g.
RevenueCat's test store); `not_ours` (product ID not ours); `malformed` (a field
we need is missing); `stale` (older than the state we hold: normal, not an error).

## Still open for the owner

1. **Prices** are first bets. Apple offers fixed price points; take the nearest.
2. **Store intro offer: recommend no at launch.** The server's 14-day trial
   covers new people; a store offer would stack on top. To add one later:
   Apple, subscription → **View all Subscription Pricing** → **Set Up
   Introductory Offer** → countries → dates → **Free** → duration (one per
   person per group); Google, base plan → add offer → eligibility **New
   customer acquisition** → phase **Free trial**.
   ([Apple: introductory offers](https://developer.apple.com/help/app-store-connect/manage-subscriptions/set-up-introductory-offers-for-auto-renewable-subscriptions), [Play: offers](https://support.google.com/googleplay/android-developer/answer/12154973))
3. **Night Pass on Apple: recommend non-renewing subscription** (the plan's
   choice), Apple's type for "a service for a limited time": it stays in the
   purchase history, and Apple expects it honoured on all the person's devices,
   which the server does. A **consumable** is "used up" and leaves no lasting
   record. Either way it can be rebought and the first rides an app version.
   The type is fixed at creation: decide before step 5.
4. **GST registration** for Play sales, and the Google 15% tier enrolment.
