# Live-event insights — what the organiser and venue owner see, and what to add

Written 2026-09-13 after driving the organiser dashboard end to end and
researching real-time event-ops practice. The headline: **most of this already
exists and is good.** This document maps what is built against best practice,
names the gaps, and proposes additions in priority order. Nothing here is built
yet; each item that is picked gets the design chain and a drive.

## What already exists (verified by driving it)

**Identity is safe on every organiser/venue/sponsor surface.** Driven as Arjun
(organiser), Fatima (venue owner) and Meera (sponsor): the room, the members
list, the live tab, the feedback digest and the chatrooms index all show the
**pseudonym** ("Cosmic Panda"), never a real name, email or user id. The one
place a real name appears is `/dashboard/attendees` — by decision 7, organisers
see *names* (never emails/ids) for their own audience — and the CSV export uses
the same HMAC pseudonym as the screen, so the two agree. `DESIGN_BRIEF_VENUES_AND_CONTROL.md:134`
("never show a host a real attendee name") governs the *room*; the attendee
roster is the deliberate, decision-7 exception. Venue owner and sponsor get the
room read-only and the pseudonyms; sponsor is bounced from an event they do not
run.

**The live tab is a real ops surface.** `lib/live-snapshot.ts` +
`lib/live-metrics.ts`, recomputed every 5s for watched events and swept every
60s for the rest, already produces:

| Signal | Source |
|---|---|
| Headcount inside (re-entry aware) | `presence_sessions`, not a counter |
| Arrival curve + check-in rate | first-arrival histogram, bucketed in SQL |
| Messages/min, active chatters | `chat_messages` |
| Open moderation flags | `moderation_flags` |
| Mood: positive / neutral / negative | `event_feedback` (classified chat) |
| Categories: entry_queue, safety_conduct, other | classifier taxonomy |

**Seven alert rules** (`deriveAlerts`), each persisted to `event_issues` with
open/acknowledge/resolve, an operational owner (door/tech/security/bar) and a
push on critical: `safety`, `entry_backing_up`, `over_capacity`,
`approaching_capacity`, `leaving_early`, `mood_sliding`, `room_died`. This is
the "issues feed with memory" TR6 asked for, and it maps directly onto the
research's crowd-density and queue-bottleneck alerting.

**Post-event feedback digest** with a disclosure floor (a category raised by
fewer than five people is named but its messages are held back so nobody is
identified) and tap-to-correct labels.

**The success number exists.** `lib/connection-metrics.ts` computes
**connections per 100 attendees** and the met %, and `lib/attendance.ts`
computes turn-up / no-show / repeat. For Blendn the honest "did this event
work" number is connections-per-100 plus the second-event rate — the loop —
and both are already computed.

## Mapped against real-time event-ops best practice

| Best practice (2025–26) | Blendn today |
|---|---|
| Real-time headcount / density | ✅ per-occurrence headcount |
| Entry / queue bottleneck alert | ✅ `entry_backing_up` |
| Crowd-safety density alert | ✅ `over_capacity` / `approaching_capacity` |
| Live sentiment / pulse | ⚠️ inferred **from chat only** — a silent unhappy room is invisible |
| Direct attendee pulse / side-channel | ❌ none — no one-tap "how is it right now" |
| Post-event NPS | ❌ deliberately deferred (`ROADMAP.md`: needs a real 0–10 question) |
| Predictive (forecast a bottleneck) | ❌ arrival rate is reactive, not extrapolated |
| Per-zone heat map | ❌ N/A — Blendn has no floor plan or zones |

## Proposed additions, in priority order

### 1. In-room live pulse — the side-channel (highest value)
Every checked-in attendee gets a one-tap, always-available "how's it here right
now?" — 👍 / 😐 / 👎 plus a single "something's wrong here" that routes like a
soft safety signal. Aggregated live into the same snapshot, disclosure-floored
(no bar until ≥5 have tapped), decaying over ~20 min so it reads *now* not
*tonight*. **Why:** today mood is inferred only from people who *type*; the
quiet attendee who is having a bad time is invisible, and they are the majority.
This is the direct answer to "a side channel for real-time feedback", and it
feeds the alerts already built (a 👎 spike is `mood_sliding` with a real
denominator).

### 2. One consolidated verdict, live and post
The numbers exist but are scattered across the live tab, connection-metrics and
attendance. Assemble one **"How it's going"** hero while live (inside vs
capacity, check-in rate, pulse, open issues) and one **"Did it work"** hero
after (connections per 100, second-event rate, turn-up, rating) — the single
line a venue owner or organiser reads to know whether to run it again. Reuses
`DESIGN_SYSTEM.md`'s one-`HeroMetric`-per-screen rule.

### 3. Post-event NPS
One 0–10 question in the thin post-event flow, disclosure-floored, rolled up per
event and per organiser. Deferred in `ROADMAP.md` for a good reason (don't fake
it from sentiment); worth scheduling as its own small ask.

### 4. Arrival forecasting (lower priority)
Extrapolate the arrival curve to warn *before* the door backs up rather than as
it does. The histogram is already bucketed; this is a projection on top.

## Risk minimisation in real time — already wired, one gap closed today
The safety path is: classifier tags `safety_conduct` → live-tab Safety alert +
critical `event_issues` row + push. **The missing link — routing that message to
the moderation *queue* — was fixed today (SCRUM-122):** a `safety_conduct`
message now becomes a `moderation_flags` row (flagged, never hidden — a call for
help is the one thing hiding makes worse) so a moderator sees it even with no
live tab open. Verified on staging that a bystander report ("that guy keeps
grabbing women") is classified 0.95 and, pre-fix, reached no queue.

## Moderation posture — verified correct (SCRUM-123)
Emotion is allowed, directed abuse is not. Verified on staging: "FUCKING
AWESOME" and "the sound is shit tonight" pass `clean`; "you are a fucking idiot,
get away from me" is `hidden`; a report about someone else is kept visible and
classified. The keyword list is slurs-only (no generic profanity) and the
OpenAI `harassment` category is directional. One tightening filed (SCRUM-123):
short slur tokens should match whole-word only, so "ba**r and i**" stops
flagging as `randi`.
