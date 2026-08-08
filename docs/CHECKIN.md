# Check-in, occupancy and attendance

Check-in is the mechanic the whole product rests on. Everything else — the
chatroom, the live count, the feedback window — hangs off someone having proved
they are physically at the venue.

---

## Three numbers, not one

This is the idea the rest of the document depends on.

| Number | Counts staff? | Answers | Where |
|---|---|---|---|
| **Capacity** | — | what the room holds | `events.max_capacity` |
| **Occupancy** | **yes** | who is in it right now | `lib/occupancy.ts`, derived |
| **Attendance** | no | who came at all | `lib/attendance.ts`, derived |

They used to be one stored counter, `events.current_capacity`, incremented on
check-in and decremented on checkout. Two production bugs came out of that in a
single day, both the same shape: a denormalised number every write path has to
maintain, that drifts and never self-corrects.

`lib/live-snapshot.ts` had already reached this conclusion and counted rows
directly, saying so in its own comment:

> *a counter held in the process is wrong after any restart, and wrong in a way
> nobody notices until an alert fails to fire*

The same is true of a counter held in a column. Meanwhile the chatrooms screen
summed the column, so **two screens answered the same question with different
numbers**. There is now a test asserting they agree.

Occupancy counts staff because **fire safety counts bodies, not job titles**.
Attendance does not, because staff are not attendees.

---

## Check-in does not refuse at capacity

The geofence deliberately covers the pavement and the door — that is what the
buffer is for. So a 100-capacity venue with 100 inside and 20 queuing has 120
people legitimately inside the boundary.

The hundred-and-first used to be refused. They were standing at the door about
to walk in, and refusing them denied the chatroom (the actual product) and
**erased them from attendance**. The organiser ended the night believing 100
came when 120 did.

**Check-in is a presence proof, not a ticket.** Nothing here sells admission;
the door does. Capacity belongs to the RSVP and to the fire officer.

Exceeding `max_capacity` is now a **signal** — `occupancy.overCapacity` — shown
rather than enforced. A room over its stated size is precisely the crowd-safety
event this product is positioned around, and the old design made it impossible
to observe.

Fill is measured against **guests**, so four crew do not fill a room of four.

---

## Staff, without a client change

Organisers and venue crew check in through the same button as everyone else.
**The client app has no notion of roles and is not gaining one** — no second
page, no "check in as staff".

It does not need to. `lib/checkin-kind.ts` decides from organisation membership:

```
staff  ⟺  the person's org runs the event  OR  owns the venue
```

Keyed on **membership, not role**, deliberately:

- an organiser at *someone else's* event is a guest, which a role check gets wrong
- an `app_admin` has no `orgIds`, so a support visit counts as a guest —
  inflating attendance by one, a far smaller distortion than silently removing
  them from a number the organiser is reading

`kind` is **stored, not derived on read**, because membership changes. Someone
who leaves the organisation next month should not retroactively become a guest
at last month's event.

### In practice this is nearly always zero

The mechanism is right and the population is not. It only fires when an
organisation member checks in **through the attendee app**, and there is no plan
for crew to have accounts there — staff log into the dashboard, not the phone. On
production today: 9 check-ins, all `attendee`, zero `staff`.

Kept because it costs nothing — a derived flag at check-in, no client change, no
extra query — and because it is correct the moment an organiser does check in,
which they plausibly will. But the UI no longer prints "0 staff" beside a real
number: the split renders only when there is one, since a permanent zero beside a
live figure is noise pretending to be a reading.

If crew ever do need to be counted, that is a **separate decision** about giving
them identities, and it is not this flag's job to pretend it has been made.

---

## Multi-day

`event_occurrences` — every event has **at least one**.

Totality is the point, not an accident. A nullable occurrence would put a null
branch in every query, and because Postgres allows unlimited `NULL`s in a unique
index it would silently remove the one-check-in-per-person guarantee from every
single-day event.

A club night that runs past midnight is **one** occurrence. It is a single
session crossing a date boundary, and splitting it would let the same person
check in again at 00:01 to the same party. The test for multi-day is a full 24
hours, not a change of date. Days are cut in the **event's own timezone** — 20:00
UTC is already tomorrow in Tokyo.

Shrinking a run **cancels** days that had attendance rather than deleting them.
`occurrence_id` cascades, so deleting would erase who came, and an organiser
correcting an end date by a day should not silently destroy a day's records.
Days nobody attended are deleted, because an empty row for a day that never ran
is noise.

### What the metrics say

`lib/attendance.ts`: unique per day, **new** vs **returning**, and retention —
of day one's guests, the share still there at the end.

For a conference that last figure is the question. A run that draws 400 on
Monday and 120 on Wednesday has a problem the total hides completely.

Two cases naive logic gets wrong, both tested: someone attending days 1 and 3
but not 2 is **returning** on day 3; and a **cancelled day is not a day nobody
came to** — it is excluded from every denominator.

Turn-up caps at 100%. Three walk-ins against one RSVP is a full house, not 300%.

---

## Presence — is this person still here?

Check-in used to be a one-shot gate. It proved you were at the venue once and
nothing revisited the claim, so anyone who left without pressing "check out"
stayed counted for ever.

### The decision is a pure function

`lib/presence.ts`. Everything hard here is judgment about noisy sensor data, and
judgment belongs somewhere cheap to test.

```
ping inside                        ─▶  stay
ping inside, was out               ─▶  clear_departure
ping outside, first                ─▶  record_departure
outside, past grace, not asked     ─▶  prompt
outside, past prompt timeout       ─▶  auto_checkout
no ping, never left                ─▶  stay          (silence is ambiguous)
no ping, was outside               ─▶  clock keeps running
occurrence ended                   ─▶  auto_checkout
staff, mid-event                   ─▶  stay
```

| Constant | Value |
|---|---|
| `PING_INTERVAL_MINUTES` | 5 |
| `DEPARTURE_GRACE_MINUTES` | 10 |
| `PROMPT_TIMEOUT_MINUTES` | 10 |
| `OCCURRENCE_GRACE_MINUTES` | 60 |

Out-of-fence is judged by **calling `evaluateCheckIn`** — the same function that
let them in. A 100m fix inside a 30m fence is a phone indoors, not someone who
left, and a separate rule would drift from the one that governs entry.

### Silence is not departure

No ping can mean a backgrounded app, a suspended process, a basement, a dead
battery, a revoked permission, airplane mode. **None of those mean the person
left.**

The distinction that makes the sweeper work: silence with *no evidence* they
left does nothing; silence *after* a confirmed out-of-fence reading lets the
clock run, because there we have positive evidence, we asked, and they did not
answer.

An earlier version got this wrong — it short-circuited on any missing ping, and
the sweeper never carries one, so the grace and prompt clocks were unreachable
and **nobody would ever have been checked out**. Caught by the integration
tests, not by review.

### The mass-checkout guard

If one sweeper pass would check out more than **25% of a room, it acts on
nobody** and raises an alert.

A venue whose wifi dies produces readings identical to everyone leaving at once.
Emptying the room on the organiser's screen would read as an evacuation, and
they are far better served by "this count is unreliable" than by a confidently
wrong number.

Days that simply *ended* are exempt from the guard, or a finished event would
never empty.

### Staff are exempt

They are in the back office, working the queue, meeting a supplier. Ejecting the
organiser from the chatroom they are moderating is worse than a stale staff
count. The one exception is the day ending, or their check-in stays open for
ever and day two counts them twice.

### Cost

Writes only on a state change, or once the ping interval has passed. 500
attendees every 5 minutes is 100 writes/min if each is persisted, near zero if
not.

---

## One checkout path

`lib/checkout.ts` `performCheckout(checkInId, reason)`.

There were three: the manual route, the branch in check-in that closes your
previous event, and the sweeper. Three copies of one idea is how they drift —
one forgets the chat cutoff, another forgets the socket event, and nobody
notices until an organiser asks why a name is still in the list.

Idempotent, which is what lets the sweeper run every five minutes without
knowing what the last pass did. The status is guarded **inside** the `UPDATE`
rather than after a read, so a sweeper pass and a live manual checkout cannot
both act.

**An automatic checkout does not cut chat access.** Someone whose GPS wandered
mid-conversation should not be thrown out of the room as well. Manual and
event-switch still do.

Relative imports throughout — reachable from `server.ts`, and `build:server`
compiles with plain `tsc`, which emits the `@/` alias verbatim into the
`require()`.

---

## Files

| File | What |
|---|---|
| `lib/occupancy.ts` | Who is in the room now, derived |
| `lib/attendance.ts` | Who came, new vs returning, retention |
| `lib/checkin-kind.ts` | Staff or guest, from org membership |
| `lib/presence.ts` | The decision, pure |
| `lib/presence-sweeper.ts` | Applying it, with the guard |
| `lib/checkout.ts` | The one way out |
| `lib/occurrences.ts` | Days of an event |
| `lib/event-phase.ts` | Lifecycle state and publish blockers |
| `app/api/mobile/events/[eventId]/presence/route.ts` | The ping |

Tests: `presence`, `checkin-kind`, `occurrences`, `event-phase` (unit);
`checkin`, `occupancy`, `attendance`, `presence-sweeper` (integration, real
Postgres).

---

## Known gaps

- **Per-occurrence capacity.** `event_occurrences.capacity` exists and is
  unread. A conference selling fewer seats on the last day wants it.
- **No client yet sends presence pings.** The endpoint and sweeper are live; the
  mobile app has to start calling it for the loop to close.
- **The attendance panel has no UI.** `docs/CLAUDE_DESIGN_BRIEF_ATTENDANCE.md`
  is written and waiting on a design round.
- **`events.current_capacity` still exists.** Nothing writes it and nothing
  reads it; drop it once production logs confirm that.
