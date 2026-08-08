# Design handoff

**For the person who designed `Blendn.fig`.**

You designed against an understanding nobody wrote down for you, and you got a
lot of it right — co-presence before a connection request, shared interests on
the card, the event attendee grid, the pre-event countdown. Where the design and
the build diverge it is mostly because no one told you the rules.

This document is the rules, the reasons, and what changes. Where something has to
change on your side, the reason is here so you can argue with it. Two of the
things in the deck are better than what we built and we are adopting them.

---

## What the product is

Someone opens the app, finds an event near them, and **checks in with GPS when
they physically arrive**. That check-in is the gate: it opens the event's
chatroom, puts them in the match list for that event, and is the only thing that
makes the organiser's numbers real.

Inside the room they are **pseudonymous** — "Cosmic Panda", a name generated per
event. They see other people as overlaps rather than as faces: *"you both picked
Techno and Board games"*. If two people both like each other, a conversation
opens and identity is exchanged.

Everything the organiser is sold — who is in the room now, whether it filled,
whether anyone actually met anyone — rests on that check-in being physical and
that room being one people speak freely in.

---

## The five rules, and why

These are not preferences. Each is enforced by a test that fails the build.

### 1. GPS check-in is what makes attendance real

There is no manual check-in and no override. Every organiser-facing number
depends on it. A design that lets someone appear at an event without being there
breaks the product's only defensible claim.

### 2. The room is pseudonymous by default

**This is the biggest change to the deck**, so the reasoning matters.

A real name and face in the room turns "the people who are here" into a
directory, and it is the thing that stops people speaking freely in the chat and
stops women in particular from being in it at all. The pseudonym is the product's
actual differentiator — a competitor can copy an events list in a fortnight, and
cannot copy a room people trust.

It costs less than it looks, because **the card names overlaps, not people**:

> **Cosmic Panda** — you both picked Techno and Board games. Both here to network.

Withholding the name loses very little when the useful part is what you share.
Identity is exchanged on a **mutual** like, and only if both people chose to be
visible. Anyone can opt to be public, per event.

**Affected:** p13 The Grid, p18 chat, p22 the place list, p28 the swipe card.

### 3. Mutual consent opens a conversation

A request the other person accepted, or a mutual like. Both require having been in
the same room. **Your p31 is exactly right** — "MUTUAL SPACE · You're both here"
is the rule, drawn.

### 4. Peer ratings are never shown to the person rated

We are adding a rating after an event for people who actually met. It is never
visible to the person rated and there is no screen where it could be.

The person most likely to rate someone badly is the person who felt least safe
with them. Show it and you have told the man that the woman who met him rated him
down, at an event where he knows who she is and may still be in the room. The
feature meant to protect her becomes what exposes her.

So: no rating badge, no star average on a profile, no "verified" tick derived
from it. If a screen needs a trust cue, we need to invent one that is not
retaliation-shaped.

### 5. Check-in never refuses

The geofence deliberately covers the queue outside, so a full room does not turn
the hundred-and-first person away — that would deny them the chatroom and erase
them from attendance. Capacity is a **signal to the organiser**, not a door.

Nothing in the attendee app should say "this event is full" at the door. Before
the event, an RSVP to a full event becomes a **waitlist** place instead.

---

## Screen by screen

### Aligned — build as drawn

| Screen | Note |
|---|---|
| **p31 Send Request** | "You're both here" + optional note. Matches the API exactly |
| **p13 The Grid** — attendee list, Join Chat, shared-interest chips | Right shape. Identity treatment changes (rule 2) |
| **p7 Your journey** — occupation, education, current base | All three exist. "Current Base" as a **city search** is better than what we have |
| **p18 event chat** — typing, images, countdown | Aligned |

### Changing — and why

**p1, p3 — phone + SMS OTP.** Not built and not served; auth today is Google and
Apple. Real work, and a fraud surface OAuth does not have. Keep the screens; they
are a decision about cost and timing, not design.

**p2 — gender required of everyone.** We ask only when someone says they are open
to dating. Less friction for the networking majority, and less data held about
people who had no reason to give it. Design a version where it is conditional.

**p18 — chat opens before the event.** We open it on check-in. Yours is a
superset and probably better; it needs a decision about what a pre-event room is
for when nobody has arrived.

**p28 — swipe deck.** Same data, different presentation, and it works — with rule
2 applied: pseudonym and no photo until someone reveals. Worth thinking about what
a swipe card looks like when the anchor is *what you share* rather than a face.

**`Match Percentage`.** We are not shipping a number — it implies a precision the
data cannot support and invites gaming. **Agreed instead: a coarse band** —
Strong / Good / Some. Strong means two or more shared interests with at least one
rare in that room; Some means compatible intent and nothing shared. Please design
the band.

**Onboarding — eight steps becomes one.** Decided: nothing between installing and
browsing. Sign in, browse, check in. At first check-in, one screen with two
chip-pickers — why are you here tonight, and what are you into. Photo and bio come
later, when someone chooses to be visible.

This is not a rejection of the eight screens; several are good and their content
survives. Two of them (`goals`, `preferences`) currently **throw away everything
the user types** — never wired up — so the real comparison is six working screens
against one.

### New — designed, never built, now in scope

Map · Notifications centre · Search and filters · Profile strength.

All four are in the deck and in neither the app nor the API. Search is closest —
the endpoint exists and nothing calls it.

### Not in the deck, needs design

- **Peer rating** — after an event, for people who connected. One screen, per
  person: a 1–5, an optional "something went wrong", an optional note. It has to
  feel like a private note to us, not a public review
- **Waitlist state** — RSVP to a full event, and being promoted when a seat frees
- **Reveal control** — the toggle that makes someone visible, per event. This is
  the counterpart to rule 2 and probably the single most important new screen
- **Presence prompt** — "are you still here?" when GPS says someone left

---

## Two things to fix that are not screens

### The progress indicators disagree

Across the deck: "30%" (p2), "20%" (p3), "STEP 02/05" (p4), "Step 2 of 4" (p5),
"70% Complete" (p7). Five systems. It reads as several explorations rather than
one flow, which makes it hard to know what is decided.

### The app has no design system, and that is the real problem

More important than any screen. Today the Expo app has:

- **No Satoshi.** `assets/fonts/` contains one file, the Expo starter's SpaceMono,
  unused. The app renders in San Francisco and Roboto
- **None of the brand colours.** Zero occurrences of `#F05423`, `#8F49AA`,
  `#BE5C71` or `#0D0C0C`. `lib/theme.ts` is the **Apple iOS system palette**
- **`#FF6B6B` as the de facto primary**, hardcoded on every onboarding CTA and in
  no token file
- **397 hardcoded hex literals** and 210 raw `rgba()` across four competing accent
  systems
- **Contrast failures**, including one in the token file itself: `textTertiary` at
  ~2.2:1, used for every placeholder. White on `#FF6B6B` is 2.79:1

So a design system that is never adopted is the current failure mode, and the
highest-value thing you can hand over is **tokens, not screens** — a palette, a
type ramp with real weights, spacing and radii, in a form an engineer can paste
into `lib/theme.ts` and delete 397 literals against.

Two constraints for that: **Satoshi has no 600 weight** (300/400/500/700/900
only), and the app currently uses `'600'` more than any other. And **ink on
orange, never white** — white on `#F05423` is 3.4:1 and fails AA.

The web dashboard's system is in `docs/DESIGN_SYSTEM.md` and is the reference.

---

## What to design next

1. **Reveal control** — blocks the whole identity model
2. **The band** — Strong / Good / Some, replacing Match Percentage
3. **First-check-in screen** — the two chip-pickers that replace onboarding
4. **Tokens** — the palette and type ramp above
5. **Peer rating** — private-note tone, not public review
6. **Waitlist and presence prompt** — smaller, self-contained

Blocked on a product decision rather than on you: phone auth, pre-event chat,
Create, and Circles — the last two have no data model at all, and we should talk
about what they are before either of us builds anything.

---

## Reference

- `USER_JOURNEY.md` — the full journey, designed vs built vs served
- `API.md` — what the server does, including the Identity section
- `CHECKIN.md` — capacity vs occupancy vs attendance, and why check-in never refuses
- `DESIGN_SYSTEM.md` — the web system, the reference for tokens
