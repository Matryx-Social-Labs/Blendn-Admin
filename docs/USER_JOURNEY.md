# The user journey

The contract between three repos: this one (API + organiser dashboard), `blendn`
(the Expo app), and `blendnorglanding` (the marketing site).

It exists because none of them knew what the others needed. An endpoint-by-endpoint
diff finds *drift*; only a journey finds *absence* — and walking it turned up four
designed features nobody had built and one shipped feature nobody was calling.

**One copy, here.** Both roadmaps reference it rather than restating it. Two
parallel journey documents drift inside a week, which is the failure
`docs/ROADMAP.md` exists to prevent.

Each step reads **designed → built → served**:

| | |
|---|---|
| **Designed** | In the Figma (`Blendn.fig`, exported 2026-08-08) |
| **Built** | In the Expo app today |
| **Served** | An endpoint exists — see `API.md` |

Endpoint shapes are **not** repeated here. `API.md` is the reference; duplicating
payloads is how the two fall out of sync.

---

## The rules that do not bend

Everything else is negotiable. These are not, and each is enforced by a test
rather than by memory.

**GPS check-in is what makes attendance real.** Every number an organiser is sold
— occupancy, attendance, retention, turn-up — rests on someone having physically
been there. There is no manual check-in and no override.

**The room is pseudonymous by default.** You are "Cosmic Panda" until you choose
otherwise, per event. `rankMatches` enforces it internally so no route can
forget, and `__tests__/chat-identity.test.ts` guards the surfaces.

**Mutual consent opens a conversation.** A message request the other person
accepted, or a mutual like. Nothing else. Both require you to have been in the
same room.

**Peer ratings are never visible to the person rated.** The person most likely to
rate someone badly is the person who felt least safe with them; surfacing it
exposes them to exactly the person they were worried about.
`__tests__/trust-not-exposed.test.ts` fails the build if any mobile route so much
as imports the trust module.

**Check-in never refuses.** The geofence covers the queue outside. Capacity is a
signal to the organiser, not a door policy — see `CHECKIN.md`.

---

## Attendee journey

### 1. Install and first open

| | |
|---|---|
| Designed | Phone number → 6-digit SMS OTP (pp. 1, 3) |
| Built | Google / Apple OAuth. Email sign-in exists in `apiClient` with no UI |
| Served | `/auth/google`, `/auth/apple`, `/auth/signin`, `/auth/signup`. **No phone auth** |

**Gap:** SMS OTP is designed, unbuilt and unserved. It is a real build — provider,
cost, rate limiting, and a fraud surface OAuth does not have.

### 2. Onboarding

**Decided: minimal.** Nothing between installing and browsing.

| | |
|---|---|
| Designed | Eight steps, hard-gated, before anything is visible |
| Built | Eight steps, hard-gated — `gestureEnabled: false`, Android back swallowed |
| Served | `PUT /profiles/:userId` accepts everything |

Two of the eight steps **discard what they collect**: `goals.tsx` and
`preferences.tsx` both note "stored locally for now" and never sync, though the
endpoint has always accepted those fields.

**The shape:** sign in → browse → check in. At first check-in, one screen with two
chip-pickers — *why are you here tonight* (intent, multi-select, "just the event"
is a first-class answer) and *what are you into* (interests). Both are things
matching needs anyway. Photo and bio are prompted only when someone chooses to
reveal, which is the first moment a photo means anything.

**The blocker underneath it:** onboarding writes interests to
`profiles.interests`, free text, from a hardcoded 28-emoji list. Matching ranks on
the **structured** `user_interests → categories` graph, and the endpoints that
populate it have **zero call sites**. Until that is fixed every match card comes
back with no shared interests, for everyone.

### 3. Browse and discover

| | |
|---|---|
| Designed | Feed · Explore · **Create** · **Circles** · Me (p7). Search, filters, a **map** |
| Built | Events · Match · Chat · Profile. No search, no filter, no map |
| Served | `/events` with category, date, distance filters; **`/events/search` exists and is never called** |

**Gaps:** map needs a viewport/bounding-box query, since a map pans rather than
searching a radius. Search is likely app-only work. `Create` implies
attendee-authored events, which has no model at all.

### 4. Event detail and RSVP

| | |
|---|---|
| Designed | Event card with attendee preview |
| Built | Full detail screen, RSVP, favourite |
| Served | `/events/:eventId`, `/events/:eventId/rsvp` |

**The app does not handle `waitlisted`.** A full event now returns that instead of
`going`, and promotion happens when a seat frees.

### 5. Check in

| | |
|---|---|
| Designed | Ambient "YOU ARE LIVE" at a place, with distance and duration (pp. 5, 22, 28) |
| Built | GPS-gated check-in to an event, with a rules tray and 50 m accuracy floor |
| Served | `/events/:eventId/checkin`, geofence with extent / buffer / accuracy allowance |

**Bug:** the client-side proximity gate compares kilometres against a metres
value, so "Check In" appears when someone is far away. The server refuses
correctly, so it is a UX failure — the user taps and is rejected.

**Design divergence:** ambient place-presence is a second mode, not a
replacement. Events are central to the design too (p13, "240 Curated Minds at
Future Echoes '24").

### 6. While you are there — presence

| | |
|---|---|
| Designed | "Active for 1 Hr 30 min", live distance |
| Built | **Nothing** |
| Served | `/events/:eventId/presence` + sweeper, live since v0.42.0 |

**The highest-value gap in the whole document.** Nobody is ever checked out, so
occupancy is cumulative — it climbs all night and never falls, on the organiser's
live screen. A shipped feature producing a wrong number on someone else's screen.

Ping `{ lat, lng, accuracy }` every 5 minutes while checked in. The server judges;
do not reimplement the geofence.

### 7. The room — chat

| | |
|---|---|
| Designed | Opens **before** the event — "STARTS IN 02:44:12" (p18). Real names. Pinned locations |
| Built | Opens on check-in. Pseudonymous. Report is a **stub** — shows a tray and calls nothing |
| Served | `/events/:eventId/chat`, `/chat/groups/:id/messages`, sockets, moderation |

**Conflict:** pre-event chat is additive and reasonable. Real names in chat is the
identity conflict — see below.

### 8. Match

| | |
|---|---|
| Designed | Shared-interest chips, mutual connections, occupation subtitle (p13); swipe deck (p28) |
| Built | Calls `/checkins` — the wrong endpoint. **Renders blank avatars on production** |
| Served | `/events/:eventId/matches`, `/matches/likes`, `/matches/preferences` — all unused |

`/checkins` stopped returning `image` in v0.46.0 when it stopped handing out real
names and photos. Correct change; the app was never updated.

`sharedInterests` comes back as **names**, ready to render. There is no score and
will not be a raw one — **a coarse band** (Strong / Good / Some) was agreed
instead of the design's `Match Percentage`.

### 9. Connect

| | |
|---|---|
| Designed | "Send Request" with **"MUTUAL SPACE · You're both here"** + optional note (p31) |
| Built | Message request with note |
| Served | `/message-requests`, co-presence enforced, blocks both directions |

**Aligned almost exactly.** The co-presence rule the design shows as its premise
is the rule the API enforces.

### 10. After — rate the people you met

| | |
|---|---|
| Designed | Not in the deck |
| Built | Nothing |
| Served | `/events/:eventId/peer-ratings` |

Only people you connected with, only after the event ends, never visible to the
person rated, one per pair. Harassment routes to moderation and is never averaged
into a score.

### 11. Settings

Four toggles now persist — push, online status, read receipts, location sharing.
They had no columns behind them, so every switch read ON regardless of choice.

---

## Organiser journey

Fully served; the surface is the dashboard, not the app.

1. **Landing → `/apply`** — public form, personal addresses need a GSTIN or website
2. **Verify → review → approved** — every application read by a person
3. **Sign in** at `dashboard.blendn.app`
4. **Create** — staged editor, categories, **geofence** with extent/buffer/accuracy
5. **Publish** — blockers surfaced before it can go out
6. **Pre-event** — RSVP pacing against capacity, **waitlist**
7. **Live** — occupancy with the guest/staff split, arrival curve, alerts
   (`over_capacity`, `entry_backing_up`, `mood_sliding`, `safety`, `room_died`),
   **live chat sentiment** since v0.48.0
8. **Post** — attendance with new-vs-returning and retention, **connections**,
   feedback, ratings, CSV export
9. **Org admin** — members, invites, domain verification, audit log

**Gaps:** portfolio calendar (events are a table only); NPS is **not computable**
from a 1–5 star and needs a real 0–10 question.

---

## Venue owner journey

1. **Claim** a venue → admin review
2. **My venues** — utilisation, ratings, returning organisers
3. **Building occupancy** — everyone inside across concurrent events, against the
   venue's own licensed capacity
4. **Events here** — read-only operational access to events at their venue

**Gaps:** availability/booking calendar — utilisation is reported after the fact,
never what is bookable.

---

## The open conflict: identity

The one thing that cannot be sequenced.

**Built:** pseudonymous rooms, identity exchanged on mutual consent.
**Designed:** real names and faces throughout — p13 "Julian Ember · Principal @
Arclight Labs", p18 chat with names and photos, p28 a full-bleed photo card. Only
p22 masks, and shows the photo anyway.

**Decided: anonymity by default, opt in to be public.** Already how the API works
— `reveal_by_default` false, per-event `revealed`, enforced inside `rankMatches`.

So the **design changes**, not the build. That is a real ask of the designer and
`DESIGN_HANDOFF.md` explains why rather than announcing it.

---

## Where the gaps live

Every gap from this document lands in exactly one roadmap:

- **API side** → `docs/ROADMAP.md` here
- **App side** → `blendn/ROADMAP.md`
- **Design** → `docs/DESIGN_HANDOFF.md`
