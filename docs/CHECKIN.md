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

**An automatic checkout does not cut chat access** at an event. Someone whose
GPS wandered mid-conversation should not be thrown out of the room as well.
Manual and event-switch still do. At a venue day every checkout cuts it — see
Go Live. Reasons: `manual` → `user`, `switched_event` → `switch`, `left_area`
and `occurrence_ended` → `sweeper`, `expired` → `expired`, `event_started` →
`ended`.

Relative imports throughout — reachable from `server.ts`, and `build:server`
compiles with plain `tsc`, which emits the `@/` alias verbatim into the
`require()`.

---

## Venue days — going live at a venue

Going live at a venue is a check-in to that venue's **venue day**: an `events`
row with `kind = 'venue_day'`, one per venue per local day, from
`venues.day_reset_hour` (06:00) in `venues.timezone`. `lib/venue-day.ts` finds
or creates it; the model, who owns it and who may see it are in
`docs/VENUES.md` § Venue days. The occurrence is the day (`occurs_on` = the
venue-local date), so the per-occurrence uniqueness keeps one check-in per
person per venue per day.

## Go Live

`POST /api/mobile/venues/:venueId/live` with where you are and
`{ "minutes": 20 | 45 | 60 }` or `{ "stay": true }` (docs/API.md).

### One door, two ways in

The event check-in and Go Live share `lib/check-in-core.ts`: the accuracy
ceiling (`vagueFixRefusal`), who may take part and the age gate
(`personAtTheDoor`), the fence and the refusal it records (`fenceRefusal`), and
everything a check-in writes (`seatAtTheDoor`: out of any other room, the row,
the session, the preferences, the room and its pseudonym, the arrival on the
roster). The routes keep only what differs — an event resolves its occurrence;
Go Live finds the venue's day, refuses when an event has the venue, and passes
a window. `__tests__/one-check-in-door.test.ts` fails if either route judges a
fence, an age or a fix, or writes a check-in, itself (PL-G03). Both doors keep
a mute and a ban a person pressed; a room you left yourself is re-entered.

### Refusals, in order

| Status | When |
|---|---|
| 429 | 20 a minute per person; also ceilings per address (300) and per venue (240) |
| 403 `PLUS_REQUIRED` | `stay` while `PLUS_GATING=true` (off: "stay" is everyone's until step 11) |
| 404 | the venue is unknown, archived or deleted — or today's venue day was deleted (closed for the day) |
| 403 `FORBIDDEN` / `AGE_RESTRICTED` | not onboarded; or no known adult age. A venue's room has no event to carry an age rule, so the account rule is its rule, and an unknown age is refused — an onboarded account with no age on file, or an under-18 from before the ruling, may not Go Live |
| 409 `EVENT_LIVE_HERE` + `eventId` | a real event has the venue (below) — check in to it instead. Before the fence, so somebody at the door is sent to the event rather than told they are outside |
| 400 `OUT_OF_RANGE` | a fix worse than 150 m, no area at this venue, or outside it: "You're not at ‹venue› yet." — **never the distance** (D-x6): a venue's area is drawn by nobody the caller knows, and the shortfall asked from a few places would draw it for them |

**Nothing is written by a refusal.** The venue's day is found, never made,
until the person is known to be standing inside its area; a refusal is recorded
in `check_in_refusals` only against a day that already exists (never against
an event at the same venue).

Go Live judges **the area today's day copied** when it was made — or the
venue's own while nobody has gone live today — and only that: no fallback to
the venue's point and the events' 30 m legacy radius (`goLiveArea`). The venue
page answers from the same area.

### When an event has the venue

`lib/venue-visibility.ts` — written once for Go Live, the venue page, the
sweeper and the Places list (`GET /venues` leaves the venue out, `venuesTakenOver`). A real event takes its venue over from
**an hour before it starts until it ends** if it is published, **public**, not
deleted, linked with a link nobody disputed (a NULL status counts, spelled out
because Prisma's `not` drops NULL), on a day that was not called off (per
occurrence, D-2), and one the person may attend (its own `min_age`, D-3) —
**and** the venue's owner confirmed the link, or the event's own area sits at
the venue: its centre inside the venue's area and buffer (`atTheVenue`, D-x3).
Any organiser can link a public event to any venue; the link alone must not let
a stranger close somebody else's venue for the evening. A private event takes
nothing over and names itself to nobody.

### The window

`event_check_ins.expires_at`, and the same instant on the room membership
(`chat_group_members.last_allowed_at`). `lib/go-live.ts`:

- **20 / 45 / 60** minutes from now. Any other number is a 400.
- **Stay**: 60 minutes, then each presence ping **inside** the fence carries it
  on to now + `STAY_EXTEND_MINUTES` (20 = the ping interval + the presence
  cutoff + 5, so a late ping still finds it open), up to `stay_until` — four
  hours from the **first** time "stay" was chosen at that venue that day. A
  switch to a fixed window turns `stay` off and keeps the cap, so choosing
  "stay" again never buys a fresh four hours (D-x5). Silence ends it. The
  extension writes only the window the ping read (still open, same end), and
  moves the room's cut-off only when it did — a sweep between the read and the
  write must not be undone.
- **Never past the reset** (D-4): a window asked for at 05:30 ends at 06:00,
  and is checked out `expired` there. **In the last five minutes before the
  reset**, Go Live opens tomorrow's room instead — a window of seconds is no
  window.
- **Going live again while live extends, never shortens**, and is not an
  arrival: the room is not told again. A window that ended but has not been
  swept is checked out `expired` at its own time first, so going again is a new
  session.
- **Going live elsewhere, or checking in to an event, ends it** as a switch (or
  as `expired`, if it had already run out).

Staff: somebody whose organisation owns the venue going live at it is `staff`,
as at an event there (`checkInKindFor`). Expiry applies to staff; the left-the-
area checkout does not, and a staff "stay" asks the fence on each ping itself.

### The room is for the people live in it

At an event, attendance outlives presence: the room stays open to somebody who
stepped out (`mayWriteToRoom`). A venue day's room does not (F6, F7, D-5):
`liveInVenueDay` admits a member only while `last_allowed_at` is in the future,
compared with the clock, so access ends the second the window does. Read,
write, the socket join, the roster room, the counter room, typing, a reply's
push, the roster, the grid, likes, waves, preferences, a reveal's visibility
(`inRoomWhere`, which also refuses a banned member) and the Banter list all ask
it — the list drops the room once the window ends, so nothing of it (last
message, counts) reads from outside. Every emit to a venue day's rooms goes
only to members live now (`emitAsSeenBy`). Go Live is the only door: no RSVP,
interest or auto-join opens it. After the reset nobody is live in yesterday's
room, so it takes no posts.

**Ending on time.** Each window schedules its own end (`lib/live-timers.ts`):
at `expires_at` it is checked out `expired`, which evicts the person's sockets
from the venue's rooms (`live:ended` to their `user:` room). The timers live in
the process; the expiry pass every 30 s is the backstop for any a restart lost.
With more than one replica, the eviction reaches sockets held by the others
only through the Socket.io Redis adapter — `REDIS_URL` must be set wherever
more than one replica runs. The per-emit filter above holds either way.

Two people count as having met at a venue's day (message requests,
`haveSharedAnEvent`) only if their windows overlapped (D-x4).

### The venue-day sweeper

`sweepVenueDays`, after `sweepPresence` on the five-minute loop, each in its
own `try`, plus `expireWindows` on its own 30-second loop
(`__tests__/venue-day-sweeper-started.test.ts`, PL-G04). Its own bounds, so
venue days never crowd real events out of the 200-room pass (F5):

1. **Expiries** (`MAX_EXPIRIES_PER_SWEEP` = 500, oldest end first, on
   `event_check_ins_status_expires_at_idx`): checked out `expired`,
   `departed_at` = `expires_at` (PL-U04). **Never through the mass-checkout
   guard** (D-20): fifty 20-minute windows ending together are a schedule, not
   a signal. Two replicas running it at once close each window once.
2. **An event starts at the venue** (at its start — from an hour before, Go
   Live there is already refused): one bounded query finds events on now at
   venues where somebody is live; each person live there is checked out with
   `departed_source = ended` (up to `MAX_CLOSED_PER_VENUE` = 500 a pass), and
   pushed once — per person, per event, for six hours — **"An event just
   started here — tap to check in"**, in our words, never the event's title or
   the venue's name, which organisers type (D-x3). The bell row is written for
   everybody, the push goes only where the person allows it, and the event's
   id rides in `data`. Somebody too young for the event's own `min_age` keeps
   their session (D-3).
3. **The fence**, the same per-room pass and guard events get
   (`MAX_VENUE_DAYS_PER_SWEEP` = 200): an out-of-fence burst at a venue day
   still trips the guard.
4. **Coordinates** where somebody went live are kept three days after the
   window ended, then nulled on the check-in and its session
   (`forgetGoLiveCoordinates`, 1,000 a pass).

The presence ping also checks out a window that has ended, so a phone pinging
past its expiry is told at once.

## Files

| File | What |
|---|---|
| `lib/occupancy.ts` | Who is in the room now, derived |
| `lib/attendance.ts` | Who came, new vs returning, retention |
| `lib/checkin-kind.ts` | Staff or guest, from org membership |
| `lib/presence.ts` | The decision, pure |
| `lib/presence-sweeper.ts` | Applying it, with the guard |
| `lib/checkout.ts` | The one way out |
| `lib/check-in-core.ts` | The one door: gates and seat, shared by check-in and Go Live |
| `lib/go-live.ts` | Go Live windows and "stay", pure |
| `lib/venue-visibility.ts` | When an event takes its venue over |
| `lib/live-timers.ts` | Each Go Live's end, at its second |
| `lib/live-count.ts` | The venue page's live count: bucketed, steady for a minute, slow to fall |
| `app/api/mobile/venues/[venueId]/live/route.ts` | Go Live |
| `lib/occurrences.ts` | Days of an event |
| `lib/event-phase.ts` | Lifecycle state and publish blockers |
| `app/api/mobile/events/[eventId]/presence/route.ts` | The ping |

Tests: `presence`, `checkin-kind`, `occurrences`, `event-phase`, `go-live`,
`one-check-in-door`, `venue-day-sweeper-started` (unit); `checkin`,
`event-door-refusals`, `occupancy`, `attendance`, `presence-sweeper`,
`go-live`, `go-live-sweeper`, `go-live-sockets` (integration, real Postgres).

---

## Known gaps

- **No client yet sends presence pings.** The endpoint and sweeper are live; the
  mobile app has to start calling it for the loop to close.
- **The attendance panel has no UI.** `docs/CLAUDE_DESIGN_BRIEF_ATTENDANCE.md`
  is written and waiting on a design round.
- **`events.current_capacity` still exists.** Nothing writes it and nothing
  reads it; drop it once production logs confirm that.
