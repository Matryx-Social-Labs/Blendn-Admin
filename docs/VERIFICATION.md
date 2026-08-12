# What is actually verified, and by what

One row per capability. Not a list of tests — a list of things the product
claims to do, each against the **cheapest tier that could actually have caught
it being wrong**.

## The rule

> **A row may only claim a tier if that tier could have failed.**

This exists because two suites in this repo have passed while proving nothing.
The photo SSRF matrix reported seven refusals against a bucket name that did not
match staging's, so every URL died on the hostname before reaching the guard —
output identical to having no guard at all. And every anonymity assertion once
ran against seed data whose pseudonyms already contained real names.

Both read as green. `lib/discriminates.ts` now encodes the counter-question as a
function (`assertDiscriminates`), and `__tests__/discriminates.test.ts` tests
that the guard itself can fail — because a false-pass detector that false-passes
is worse than none.

## The tiers, cheapest first

| Tier | Cost | How to run |
|---|---|---|
| **unit** | free, ~5s | `npm test` — 1090 API / 116 app |
| **integration** | free, CI | `npm run test:integration` — real Postgres, rebuilt each run |
| **smoke** | free, ~20s | `npm run smoke:staging` — live staging, exits non-zero |
| **device (local)** | **free, unlimited** | `npx expo run:ios --device` — a real phone, no EAS quota |
| **TestFlight** | **one EAS build** | only for people who are not holding your laptop |

**Reach for the cheapest tier that can fail.** The last row is the only one that
costs anything, and it buys distribution, not confidence — see
`blendn/docs/RELEASING.md`.

---

## Identity and anonymity

| Capability | Tier | Status |
|---|---|---|
| Identity is invisible by default — stranger, co-attendee, one-sided like | integration · `identity-gate.itest.ts` | ✅ |
| Identity appears on a mutual like at the same event, and not across events | integration · `identity-gate.itest.ts` | ✅ |
| `maySeeIdentity` does not survive a close | unit + integration | ✅ |
| The room card shows the pseudonym, never the real name | integration · `matches.itest.ts` | ✅ |
| The card never reveals whether they liked you | integration · `matches.itest.ts` | ✅ |
| Typing indicators and push titles respect reveal state | unit · API #198 | ✅ |
| DM header shows the same pseudonym the card showed | **device** · checklist §C1 | ⬜ |

## Leaving a match

| Capability | Tier | Status |
|---|---|---|
| Close is soft — rows retained for moderation | unit + integration | ✅ |
| Close reaches every door: detail, messages, send, reveal, socket join | integration · `dm-gating.itest.ts` | ✅ |
| Evidence survives a close, author still resolvable for suspension | staging, by hand, 2026-08-11 | ✅ |
| Leaving is permanent — re-liking cannot reopen | staging, by hand, 2026-08-11 | ✅ |
| Block hides both directions of matching | integration · `dm-gating.itest.ts` | ✅ |
| Block reaches group chat history, socket and push | unit · `block-reaches-the-room.test.ts` | ✅ |
| Block reaching a **live** socket in the room | **device**, two phones | ⬜ |
| The leaving sheet's post-reveal copy | **device** · checklist §C7 | ⬜ |

## Photos

| Capability | Tier | Status |
|---|---|---|
| SSRF guard: only our bucket, our folder, https, no traversal | unit + **smoke** (discriminating) | ✅ |
| Blank/undersized photos refused via `HeadObject` | unit · `photos.test.ts` | ✅ |
| `User.image` mirrors the primary and clears on empty | unit · API #204 | ✅ |
| Moderation degrades open, records `unchecked` | unit · `photo_checks` | ✅ |
| The 40px blur is what actually reaches an unrevealed viewer | **device** — intercept the payload | ⬜ |

## Realtime

| Capability | Tier | Status |
|---|---|---|
| Socket rejects a bad token, accepts a good one, denies a foreign room | **smoke** | ✅ |
| Reconnect carries a **fresh** token after the 15-min expiry | **device** · checklist §A3 | ✅ **2026-08-12** |
| Presence pings close the loop | — | ❌ **no client sends them** |

## Notifications

| Capability | Tier | Status |
|---|---|---|
| `push_enabled: false` suppresses everything | unit · both token getters | ✅ |
| Match / reveal-request / reveal fire, with `conversationId` | unit · API #202 | ✅ |
| No name on a lock screen, real or pseudonymous | **device** · checklist §B2 | ⬜ |
| Only the earlier liker gets the match push | **device**, two phones · §B3 | ⬜ |

> Push **delivery** cannot be observed over HTTP. Smoke will never cover this
> row; a device is the only tier that can fail here.

## Deploy health

| Capability | Tier | Status |
|---|---|---|
| Health reports a genuinely connected database | **smoke** | ✅ |
| Validation returns 400 with field errors, not 500 | **smoke** | ✅ |
| Cron endpoints fail closed | **smoke** | ✅ |
| OpenAPI spec serves and parses | **smoke** | ✅ |
| `just_here` is exclusive server-side | **smoke** (discriminating) | ✅ |
| A conversation you are not in is 404, not 403 | **smoke** | ✅ |

---

## Known gaps, named rather than absent

**The app has no component tests, by construction.** `jest-expo` runs on
`testEnvironment: "node"` with no `@testing-library/react-native`, so screen
behaviour cannot be asserted in CI at all. Every ⬜ above that says "device" is
device-only *because of this*, not because nobody got round to it. Deferred
deliberately — screens are still moving — and recorded so the shape of the gap
is visible.

**The lifecycle rows are integration-tested, not smoke-tested, on purpose.**
Reveal and close are one-way: you cannot un-reveal or re-open. A smoke suite
running them against staging would work once and then assert against its own
leftovers forever. Integration tests get a database rebuilt on every run, which
is the only place a one-way transition can be re-tested honestly.

**Presence is the one ❌.** The endpoint and the sweeper are live and tested; no
client calls them. It is not a broken feature, it is an unfinished one, and it
should not sit in a list of green rows pretending otherwise.

---

## Running the whole thing

```bash
# both repos
npm test

# API only — needs a database
npm run test:integration

# against live staging; add the account to include the authenticated half
SMOKE_EMAIL=… SMOKE_PASSWORD=… SMOKE_BUCKET=blendn-media-staging npm run smoke:staging
```

**`SMOKE_BUCKET` must match the environment.** Get it wrong and the photo check
fails loudly with *"the control failed — SMOKE_BUCKET is probably wrong"*, which
is the entire point: the previous version of that test got it wrong and reported
success.

The device rows live in [`blendn/docs/TESTING_CHECKLIST.md`](../../blendn/docs/TESTING_CHECKLIST.md)
for engineers, and `blendn/docs/TESTER_GUIDE.md` for everyone else.
