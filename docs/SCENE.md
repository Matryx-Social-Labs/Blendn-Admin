# The Scene — the event detail screen

Figma `HO0UnAEV5djzo0h4q7Y2vi`, frame `1141:4853`, 390 × 1971.

**It is not a feed.** The name reads like a third tab beside The Pulse and
Hotspots, and it is the *detail* screen — one event, opened from a card. It maps
to `components/screens/EventDetailScreen.tsx`, not to a route under `(tabs)`.

Worth stating first because the Pulse rebuild started from the opposite
assumption about Hotspots and cost a day.

## What it draws, top to bottom

| | |
|---|---|
| Top bar | The same overlay as the Pulse — glyph, `Blend'n` wordmark, bell |
| Hero | Full-bleed photograph, no inset |
| Access pill | "LIMITED ACCESS" — outlined, accent, over the hero |
| Title | "The Scene", large, over the hero |
| Meta row | 📅 date · 🕐 "21:00 — Late" |
| The Experience | Section header, then body copy with an **accent inline link** |
| Attendees | Header, "124+" in accent, and an **avatar stack** |
| Location | Card: venue name, area, and a **map** with an accent pin |
| Amenities | Two tiles — "Open Bar / Premium Spirits", "Pro Photo / Digital Gallery" |
| CTA | Sticky "Join the Experience **$45**", gradient-bordered pill |

The frame is **flattened** — `get_metadata` returns the frame with no children —
so per-element geometry has to come from `get_design_context` when the screen is
built. Do not eyeball it from the render; that is what produced three wrong
numbers on the filter button.

---

## Four things it draws that do not exist

### 1. The attendee avatar stack — and this one is a decision we already made

The frame shows two faces and "+121".

**We removed exactly this, deliberately, as a security fix.** `GET /events` used
to return `interestedPreview` — real photographs of everyone who had favourited
an event, to any authenticated caller, with no identity gate. Both that and
`GET /events/:id/interested-users` now return a **count** and an empty array
(blendn-admin #229, SCRUM-25).

The reasoning has not changed: **a face is identity**, and it was harvestable by
topic — favourite an event, ask, collect the faces of everyone else interested in
that category. A category plus a face is an inference about a person.

So the stack cannot be built as drawn. `124+` is real and already on the payload
as `favoriteCount`; the faces are not coming back. Options, in order of
preference:

1. **The count alone**, larger — it is the social proof the design is reaching
   for, and the frame already leads with it.
2. Generic silhouettes rather than photographs, if the composition needs the
   shape of a stack.
3. Real faces **only for people you have matched with**, which is a different
   feature and needs the friend graph (app roadmap, deferred).

### 2. The map

`react-native-maps` is not installed. Same dependency the Hotspots "Explore the
Grid" card needs — bundle both into one dev-client build so testers install
once.

### 3. Amenities

"Open Bar", "Pro Photo" have no column. `events` has `house_rules` — free text,
a different thing. A curated amenity vocabulary is a small schema addition and
belongs with the category work, not invented per event as free text.

### 4. A price

"$45". There is no ticketing, no payment, and the roadmap says pricing is
undecided and everything is free. The CTA has to read as joining, not buying,
until that changes — and if it never changes, the price is simply not drawn.

---

## What already exists and should be reused

`EventDetailScreen.tsx` is built and wired. It already has the check-in flow,
the room, the RSVP and the favourite. This is a **restyle** against the frame,
not a rebuild — the same mistake to avoid as the Pulse, where a rewrite of
behaviour was proposed and dropped once the two halves were measured.

`favoriteCount`, `currentCapacity`, `venue_name`, `address`, `start_time`,
`end_time` and `short_description` are all on the payload already.

---

## Design review — what was measured, 2026-08-16

The screen is built. `/plan-design-review` measured it against the frame node by
node. Fidelity went 7/10 → 9/10; the deltas below are the work outstanding.

**Correction to this document:** the frame is **not** flattened. `get_metadata`
returns it with no children, which is what the earlier note recorded — but
`get_design_context` returns the full tree with per-element geometry. Use that.

| Node | Frame | Built | Δ |
|---|---|---|---|
| `1141:4901` card inner | `pb-56` | 32 | −24 |
| `1141:4904` venue name | `pt-16` | 8 | −8 |
| `1141:4903`/`4905` | Plus Jakarta **Regular** | Bold | weight |
| `1141:4899` right column | `gap-48` | 64 | +16 |
| `1141:4919`/`4925` icons | 18 and 20 | 20 and 20 | +2 |
| `1141:4917` tiles | `grid-rows-126px` | content-sized | height |
| `1227:2912` CTA icon | 40 | 24 | −16 |
| `1227:2903` CTA | inset 24 | inset 12 | −12 |

### The CTA floats

`1227:2903` is named **"Floating CTA"** and is a *sibling* of `Main`, not a child
— it sits outside the scrolling content at 74pt. It was built as the last element
inside the ScrollView, which buries the only action this screen has at the bottom
of a ~1900pt page. When a node name says Floating, check its parent before
placing it in the scroll.

### The map is texture, not orientation

Frame `1141:4911-4913`: 50% opacity, white `mix-blend-saturation` (fully
desaturated), an `rgba(255,144,109,0.1)` wash, and a 48pt gradient pin. Full
fidelity was chosen deliberately. **Consequence, accepted:** at that treatment
street names are not readable, so the card says "roughly here, and it's ours"
rather than letting anyone navigate by it.

### Contrast, measured

Every pair passes WCAG AA on `#0F0E0E`: `#AEAAAA` 8.38:1, accent `#FF906D`
8.69:1, white 19.28:1, amenity violet `#F79EFF` 10.36:1, amenity rose `#FF6D8D`
7.18:1. Open: no cap on dynamic type at the 48pt title, and no VoiceOver pass.

## Build order

1. Measure with `get_design_context`, one section at a time.
2. Restyle what exists — hero, pill, title, meta, body, location card.
3. Attendees as a **count**, pending the decision above.
4. Amenities and the map only once they have data behind them.
5. Verify each section on the simulator via the `__preview` harness before
   moving to the next, as the Pulse work now does.
