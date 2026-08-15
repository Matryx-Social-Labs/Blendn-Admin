# Hotspots — the venue half of the product

Figma `HO0UnAEV5djzo0h4q7Y2vi`, frames `1107:*`. This file is the record of what
those frames mean, because the screens do not explain themselves and the first
reading of them was wrong in a way that would have shipped a live-location leak.

**Hotspots is not a venue directory.** It was described as "a replica of the
Pulse page showing venues", and the frame is nothing of the kind: it is a
**proximity and presence** surface. Venues are the *unit* it groups people by,
not the thing it lists.

---

## The keystone: nobody is discoverable by default

Frames `1107:2596` (Go live at a venue) and `1107:3657` (duration sheet).

You do not appear to anyone near you until you perform a deliberate,
**time-boxed** act: *Go Live* at a named venue, for **20 / 45 / 60+ minutes**.

And it is **reciprocal**. Before you go live, `Nearby Profiles` and `Similar
Interests` render as **LOCKED VIEW** — blurred rows behind padlocks. You buy
sight with your own visibility, for a bounded window, at one place.

This matters more than any other decision in this area, so it is written down
first:

| Property | Consequence for the build |
|---|---|
| Opt-in per session, not a setting | There is no "discoverable" boolean on `profiles` to get wrong. A live window is a **row with an expiry**, and when it lapses you are gone with no further action |
| Scoped to one venue | "Who is near me" is never a radius query over the whole city; it is "who else is live at this venue right now" |
| Reciprocal | The read is gated on the reader also being live. A caller who is not live sees counts and locks, never a person |
| Expiring | Stale presence cannot accumulate. The window is the retention policy |

**This is why the design is safe and the first reading was not.** A naive
"People Around You" — job title, current venue, neighbourhood, shown to any
stranger in a 4km radius with no consent step — inverts the product's whole
spine (GPS check-in, pseudonymity, mutual like before contact) and is exactly
the risk class flagged on peer ratings. The frames never asked for that. They
ask for a nightclub cloakroom ticket: hand something over, get something back,
both expire.

Build the gate first. Every screen below is a read through it.

---

## Frame inventory

| Screen | Node | Notes |
|---|---|---|
| The Hotspot (home) | `1107:3240` | Presence counts, current vibe, trending venue, People Around You, Upcoming Plans |
| The venue | `1107:3394` | |
| Venue members | `1107:3070` | |
| Go live at a venue | `1107:2596` | The consent gate. Locked state for everything else |
| Go-live duration sheet | `1107:3657` | 20 / 45 / **60+ (crown)** |
| Live discovery | `1107:3496` | The Grid's shape, venue-scoped rather than event-scoped |
| Anonymous group chat | `1107:2721` | |
| 1:1 / DM chat | `1107:3186` | |
| Chat and connections | `1107:2775`, `1107:2939` | |
| Profile like / dislike | `1107:3616` | |
| Bio | `1107:3698` | |
| Send request | `1107:3717` | |
| Mutual like popup | `1107:3600` | |

---

## What exists, and what does not

`GET /api/mobile/venues` shipped in #230 and covers the venue rows — name, type,
city, distance, next event. It is the "Trending near you: Cafe Coffee Day,
4.2km away" line and nothing more.

| The frame draws | Behind it |
|---|---|
| "250+ PEOPLE ARE AROUND YOU", "12 nearby now", "10+ PEOPLE HERE NOW" | **nothing** — needs live presence |
| "Chitrakala Parishat · Kumarapark · 34 people blending" | venue ✅ · count ❌ |
| "Trending near you · 4.2km away · View Cluster" | ✅ venue + distance · "trending" ❌ |
| Nearby Profiles / Similar Interests / People Around You | `work_field` ✅, reveal flow ✅, `blocked_users` ✅ · **who-is-live-here ❌** |
| Upcoming Plans | ✅ buildable now from `event_rsvps` |
| Go Live | ❌ |

The only presence endpoint today is `POST /events/:eventId/presence`, and it is
scoped to an event you have already checked into. Nothing answers "who is here"
for a venue.

---

## Two things the frames assert that the product has not decided

Raised rather than silently resolved, per the standing rule that missing logic
behind a drawn element is a question, not a guess.

### 1. The crown on "60+ mins"

`1107:3657` marks the longest window with a crown — the visual language of a
paid tier. The roadmap says pricing is undecided and everything is free. Built
as available to everyone until that changes; the crown is drawn but not
enforced, and this line is the reminder that it is a stub and not a decision.

### 2. Real names in the locked view

`1107:2596` blurs the photographs behind padlocks and leaves **"Vivek, 40"** and
**"Venessa, 31"** perfectly legible underneath.

That contradicts the identity model the rest of the app enforces: this product
withholds a real name until a mutual like, an opened conversation, or a
deliberate reveal — `lib/anonymous-names.ts` exists to give people pseudonyms in
exactly this situation, and the roster leak and the interested-list leak were
both this shape.

A first name and an age, attached to a venue and a timestamp, is identifying. A
blurred face next to a crisp name protects the wrong half.

**Rendered with pseudonyms until the designer says otherwise.** That keeps the
composition — a name-shaped string, an age, a time — and loses nothing visually,
which is the cheapest possible way to be wrong in the safe direction.
