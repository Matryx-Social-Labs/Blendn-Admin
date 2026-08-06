# Blend'n — location, geofencing and check-in brief

Paste into Claude Design. Scope is **one stage of the event editor plus its
mobile counterpart**: how an organiser defines *where the event is*, and what an
attendee sees when they try to check in.

This is the most important screen in the product and the previous round
under-designed it. Everything else in the dashboard is designed and shipped.

---

## Why this matters more than it looks

**Blend'n's entire premise is that everyone in an event's chatroom is physically
there.** Check-in is GPS-validated, and the chatroom is the product. If check-in
is wrong, the product is wrong in both directions:

- **Too strict** → someone standing inside the venue can't get in. They churn at
  the exact moment they were most engaged. This is the worse failure.
- **Too loose** → someone in the car park, the café next door, or a different
  event in the same complex joins the room. The "everyone here is actually here"
  guarantee quietly stops being true.

The previous design reduced all of this to one switch:

> ☑ GPS check-in required (attendees check in within 200m)

A hardcoded number, no map, no way to set it. That is the thing to replace.

---

## The model to design against

The current implementation stores one number, `check_in_radius`, and it
**conflates three different quantities**. Separating them is the whole design
problem:

| Quantity | What it is | Who decides |
|---|---|---|
| **Extent** | The venue's actual physical size. A café is 20 m across; Chinnaswamy Stadium is 200 m. A fact about the world. | traced on a map |
| **Buffer** | Deliberate tolerance — the queue outside, the pavement, the car park. | the organiser |
| **Accuracy allowance** | How wrong *this particular* GPS fix is. The phone reports it per reading; indoors it is routinely 20–65 m. | the device, at check-in |

The rule:

```
inside  =  distanceToGeofence(attendee, geofence)
           ≤  buffer + min(deviceReportedAccuracy, 75m cap)
```

**Why this matters for the design:** because the accuracy allowance is applied
per check-in, the organiser no longer has to inflate the shape to absorb bad
GPS. They draw the venue *as it actually is*, and the system handles the noise.
Tight geometry plus adaptive tolerance gives fewer false rejections **and** less
overlap — instead of trading one against the other, which is what one fat radius
forces.

The UI has to make that legible, or organisers will still draw huge shapes "to
be safe".

---

## What to design

### A. The geofence editor (dashboard, "Location & Check-in" stage)

A map. Leaflet with OpenStreetMap is already in the product and working
(`components/location-picker.tsx` — search, drag-a-pin, reverse-geocode, live
radius circle). Satellite imagery will be added as a layer so buildings can be
traced.

**Two modes, and the choice between them needs designing:**

1. **Circle** — drop a pin, drag a radius. Right for most venues, and the
   default. Fast.
2. **Polygon** — trace the building or ground outline. For a stadium, a
   convention centre, a campus, a park, an irregular rooftop.

Show: how someone switches, how they draw and edit a polygon (add a vertex, move
one, remove one, close the ring), and what happens if they draw something
degenerate (two points, a self-crossing ring).

**The buffer is a second, visually distinct ring** outside the extent. It must
not read as "the radius" — the whole point is that they are different things.
Show the two together, and label them so the difference is obvious without
reading documentation.

**Show the accuracy allowance.** The organiser should understand that a
real check-in is tolerated *beyond* the buffer, and roughly by how much. A
third, faintest ring is one option; a sentence may be better. Your call — but
the organiser must not be surprised later that someone 60 m out got in.

**Scale matters.** Design this for a 20 m café *and* a 200 m stadium. The
controls that work at one zoom must work at the other.

### B. The overlap warning

Two events can legitimately share a geofence — a conference with three tracks in
one building is *meant* to. So this **warns, never blocks**.

Design what the warning looks like when the organiser's shape overlaps another
event running at the same time: which event, whose it is, how much they overlap,
and what the organiser can do about it (shrink, move, or accept). It should read
as information, not as an error.

### C. The mobile check-in states

The other half of this, and currently unspecified. Design what the attendee sees:

- **Success** — checked in, and the chatroom opens.
- **Too far** — *"You're about 40 m outside."* Should it show a map? A direction?
  This is the state that decides whether someone churns or walks 20 metres.
- **Signal too weak** — the device's own accuracy is worse than we can work with.
  Tell them what to do (step outside, move away from the building).
- **Ambiguous** — the point is valid for two concurrent events in the same
  building. If they RSVP'd to one, we pick it silently. If not, they choose.
  Design that chooser.
- **Too early / too late** — the event hasn't started, or has ended.
- **Full** — capacity reached.

### D. Venue geofence reuse

Venues are a real table now. A venue owner should be able to define the geofence
**once on the venue**, and any event there inherits it — with the organiser able
to override per event (a rooftop-only event at a three-floor venue). Design the
inheritance and the override.

---

## Categories — the correction

The previous round invented this taxonomy:

> Music (Indie / Alt, Electronic, Live gigs) · Sports (IPL Streaming, Football
> screening, Run clubs) · Social (Board games, Salsa & dance, Mixers) ·
> Food & Drink (Brewery nights, Tastings)

**That is not the real taxonomy, and it is far too narrow.** It reads as though
Blend'n is a nightlife app. It is not — it is for **any** event: a cricket match
at a stadium, a tech conference, an art exhibition, a flea market, a marathon, a
temple festival, a job fair.

The real taxonomy is two levels, and after this work it is:

**Music** · **Sports** (incl. *Live matches (stadium)*, screenings, marathons,
tournaments) · **Business & Professional** (conferences, expos & trade shows,
seminars, workshops, job fairs, product launches) · **Arts & Culture**
(exhibitions, theatre, film, literature, art fairs, heritage walks) ·
**Food & Drink** · **Markets & Fairs** (flea, craft, farmers, pop-ups) ·
**Learning** (classes, bootcamps, kids & family) · **Tech** · **Networking** ·
**Outdoor** · **Wellness** · **Community** (volunteering, festivals &
celebrations, family, language exchange) · **Nightlife**

Nightlife is **one parent of thirteen**, not the frame.

Design implication: a category picker showing thirteen parents and ~55 children
cannot be a flat checkbox list — which is exactly what ships today, 55
alphabetised checkboxes with parents and children indistinguishable. Design the
grouped picker, including how the **primary** category is chosen (it decides
where the event surfaces first in the app).

---

## Constraints (unchanged, and these bit last time)

- **Colour**: `--primary` `#F05423`, purple `#8F49AA`, rose `#BE5C71`, ink
  `#0D0C0C`. Text on orange is **ink, not white** (white is 3.4:1, fails AA).
- **Type**: Satoshi 300/400/500/700/900. **There is no 600.**
- **Dark-first**, no theme toggle. Map tiles are light — design the seam between
  a light map and a dark UI deliberately; it is the one place they meet.
- **Container queries** (`@sm/main:`, `@3xl/main:`), never viewport breakpoints —
  the sidebar is 288px and collapsible.
- **No `dialog` primitive installed.** Confirmations are inline or in a sheet.
- **One `h1` per page**, owned by the top bar.
- **Icons outlined**, never filled.
- **Do not invent data.** The last round mocked up session devices and locations
  that NextAuth does not record, and they were cut during implementation. If a
  number is needed that we do not store, say so rather than drawing it.
- **Empty is the common case** — this product has ~44 users.

Available primitives: avatar, badge, button, calendar, card, chart, checkbox,
drawer, dropdown-menu, form, input, label, popover, progress, radio-group,
select, separator, sheet, sidebar, skeleton, slider, sonner, switch, table,
tabs, textarea, toggle, tooltip.

---

## Deliver

1. The **geofence editor** — circle and polygon modes, buffer ring, accuracy
   explained, at both café and stadium scale, desktop and mobile.
2. The **overlap warning**.
3. The **six mobile check-in states**.
4. **Venue-level geofence** and its per-event override.
5. The **grouped category picker** with primary selection.
6. A **component sheet** for anything new.

Match the shipped dashboard rather than introducing a new language —
`docs/DESIGN_SYSTEM.md` and the two previous briefs in `docs/` are the
reference.
