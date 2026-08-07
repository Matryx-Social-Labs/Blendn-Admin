# Blend'n — attendance and occupancy brief

Design the attendance panel on the event Overview, and the over-capacity signal
on the live screen.

The data is real and already computed. `lib/attendance.ts` and
`lib/occupancy.ts` exist, are tested, and return exactly the shapes below.
**Do not invent metrics** — a previous round mocked up session devices and
locations NextAuth does not record, and they were cut during implementation.

---

## The idea that has to survive the design

Three numbers that used to be one, and conflating them is what caused the bug
this work came from:

| Number | Counts staff? | Answers |
|---|---|---|
| **Capacity** | — | what the room holds |
| **Occupancy** | **yes** | who is in it right now — fire safety counts bodies |
| **Attendance** | no | who came at all — staff are not attendees |

The live screen must show occupancy **and** its split, because they are
different questions asked by the same person ten seconds apart:

> **142 in the room** — 138 guests, 4 staff

If a design makes those look like one number, it is wrong.

---

## What to design

### A. The attendance panel (event Overview, past and live events)

```ts
{
  uniqueTotal: number       // distinct guests across the run
  going: number             // said they were coming
  turnUpPct: number | null  // null when nobody RSVP'd
  singleDay: boolean
  retentionPct: number | null
  days: Array<{
    occursOn: string        // "2026-09-02"
    unique: number
    newcomers: number       // first day of this event they appeared
    returning: number
    cancelled: boolean
  }>
}
```

**Single-day is the common case and must degrade to one honest number.** Most
events are one evening. A five-column chart rendering a single bar is worse than
a plain figure — design that state first, then the multi-day one.

For multi-day, the useful question is not "how many came" but **"did it hold?"**
New versus returning per day, and the retention figure. A conference that draws
400 on day one and 120 on day three has a problem the total attendance number
hides completely.

**Cancelled days must read as cancelled**, not as a day nobody came to. They are
excluded from every denominator; the design should make that visible rather than
leaving a mysterious gap.

### B. The over-capacity signal (live screen)

Check-in no longer refuses at capacity. The geofence covers the pavement, so
people queuing outside are legitimately inside the boundary, and turning away the
hundred-and-first denied them the chatroom and erased them from attendance.

So a room over its stated capacity is now **observable for the first time**, and
it is exactly the crowd-safety moment this product is positioned around.

```ts
{ inside, guestsInside, staffInside, capacity, fillPct, overCapacity }
```

Design what "over" looks like. It is not an error — nothing is broken, the room
is just fuller than planned. It should be impossible to miss and should not
imply the app has malfunctioned.

### C. The unreliable-count state

The presence sweeper refuses to auto-check-out more than a quarter of a room in
one pass, because a venue whose wifi dies produces readings identical to
everyone leaving at once. When that trips, the organiser is told the count is
unreliable rather than handed a wrong number.

Design that state. **"We are not sure right now"** is a genuinely hard thing to
show next to a big confident figure, and getting it wrong in either direction is
bad: too quiet and nobody notices, too loud and it reads as an outage.

---

## Constraints

- **Satoshi**, weights 300/400/500/700/900. **There is no 600.**
- Brand `#F05423` orange, `#8F49AA` purple, `#BE5C71` rose, `#0D0C0C` ink.
  **Ink, not white, on orange** — white is 3.4:1 and fails AA.
- **Container queries** (`@sm/main:`, `@3xl/main:`), never viewport breakpoints.
  The sidebar is 288px and collapsible.
- Charts are **recharts 2**, already in use elsewhere on the dashboard — match
  those, do not introduce a second charting idiom.
- **One hero metric per screen.** The Overview already has one, which changes
  with lifecycle state; this panel sits below it and must not compete.
- Empty is the common case throughout this product. An event nobody attended
  should look deliberate, not broken.
- No `dialog` primitive exists.

---

## Deliver

`screen-attendance-panel.jsx` and `screen-occupancy-live.jsx`, plus the
unreliable-count state as a variant rather than a separate screen.
