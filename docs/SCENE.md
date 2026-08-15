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
| CTA | Sticky "Join the Experience **$45**", gradient-bordered pill — built as a content-width **"Blend in"** glass pill; see the CTA section below |

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

**All closed** (app #171, #172, #177). Kept as the record of what was wrong
and why, because two of them had causes that will recur.

| Node | Frame | Was | Now |
|---|---|---|---|
| `1141:4901` card inner | `pb-56` | 32 | **56** |
| `1141:4904` venue name | `pt-16` | 8 | **16** |
| `1141:4903`/`4905` | Plus Jakarta **Regular** | Bold | **Regular** |
| `1141:4899` right column | `gap-48` | 64 | **48** |
| `1141:4919`/`4925` icons | 18 and 20 | 20 and 20 | **18 and 20** |
| `1141:4917` tiles | `grid-rows-126px` | content-sized | **126** |
| `1227:2912` CTA icon | 40 | 24 | **26**, a deviation — see below |
| `1227:2903` CTA | inset 24 | inset 12 | **centred**, content-width |

**The weight was wrong because the font was never loaded.** Plus Jakarta
Regular was not in `EMBER_FONT_MODULES`, and a `fontFamily` naming an
unloaded family does **not** throw and does not warn — it silently renders
the system font, which on a dark screen reads as "a slightly different
weight" rather than as a bug. `__tests__/fonts.test.ts` guards both
directions now: every name resolves to a loaded module, and nothing is
loaded that the type scale never asks for.

**The two icon sizes are not a mistake in the design.** A tall narrow
martini glass and a wide round camera at the same box size do not look the
same size; 18 and 20 are optical sizing, and copying them is the whole
point of measuring rather than eyeballing.

**The 126pt tile height matters for a vocabulary that does not exist yet.**
Content-sized, the pair agreed only while both subtitles fit one line —
which today's two fixtures happen to do. The first longer amenity name
would have made the row ragged.

### The CTA floats

`1227:2903` is named **"Floating CTA"** and is a *sibling* of `Main`, not a child
— it sits outside the scrolling content at 74pt. It was built as the last element
inside the ScrollView, which buries the only action this screen has at the bottom
of a ~1900pt page. When a node name says Floating, check its parent before
placing it in the scroll.

### The map keeps its legibility and takes the frame's pin

Frame `1141:4911-4913` treats the map as texture: 50% opacity, white
`mix-blend-saturation` (fully desaturated), an `rgba(255,144,109,0.1)` wash, and
a 48pt gradient pin. Copied exactly, street names stop being readable.

**Decision: adopt the pin and a lighter wash, keep the map legible.** The pin is
the element carrying the brand, and it is free to take. The greyscale is the only
part that trades away the card's job, and that trade was not worth making — the
slot exists to answer "roughly where is this", with panning reserved for
Hotspots' Explore the Grid.

So: dark-styled static map as built, POI and transit off, plus the accent overlay
at reduced alpha and the 48pt gradient circle drawn as a React Native view over
the image rather than as a Google marker parameter (the static API takes a flat
colour or a hosted icon, neither of which can be a gradient).

### The CTA, redesigned — 2026-08-16

Three deliberate departures from `1227:2903`, all recorded here so the frame and
the build disagreeing is a decision rather than drift.

| | Frame | Built | Why |
|---|---|---|---|
| Height | 74 | **58** | The 74 comes from a **40pt icon** (`1227:2912`) beside a 28pt line — the icon sets the box on its own. Docked over an ~88pt tab bar that made 186pt of permanent chrome, better than a fifth of the screen. Icon drops to 26, the label sets the height, pill lands at 58 |
| Width | full bleed | **content** | A full-bleed pill is a *bar*, and a bar reads as part of the app's frame. The node is named "Floating CTA"; padded to its label it can actually float |
| Fill | opaque + gradient border | **tinted glass + hairline** | See below |

**The gradient border and a translucent fill are mutually exclusive.** The pill
was a `LinearGradient` with `padding: 1` wrapping an opaque child — the standard
way to fake a gradient border, and it works *only* while the child is opaque.
Make the child glass and the whole gradient **rectangle** shows through: the
first attempt rendered a brown-to-purple wash inside the pill instead of a
stroke around it. React Native has no gradient `borderColor` and no masking
without a new dependency. So the ring is a hairline of white at 18% — the actual
glassmorphism idiom, an edge lit by light passing through the sheet.

**The tint is warm, and that is not decoration.** A neutral `rgba(15,14,14,0.5)`
was tried first, and it is what glass on this screen genuinely looks like: the
pill docks over the bottom of a dark map on `#0F0E0E`, so there is nothing
luminous behind it to refract and neutral frost renders near-black. It read as a
*disabled* control in the position of the primary one. The tint is `#4B2F26` —
`gradientFrom` at 25% over the page background — so the warmth the gradient ring
used to carry stays, and the icon takes the accent.

**The dock lost its band.** It carried a full-bleed blur and scrim, which was
right while the pill was opaque: the band was the pill's bleed. With a glass
pill it is a second full-width sheet of glass behind the first, which is a
toolbar, not glassmorphism. Removed — the pill floats, with the page visible and
frosted either side of it.

Pinned by `__tests__/sceneCta.test.ts` in the app repo, including the height
arithmetic (`2 + 2×padding + max(icon, lineHeight) === SCENE_CTA_HEIGHT`) and
the assertion that the icon may never be the thing setting the height again.

**Copy: "Blend in", not "Join the Experience".** The frame's label would fit any
event app. The product is named for the thing the button does, so the button is
the one place the name can be a verb rather than a logo. "You're in" for the
joined state.

### The tab bar's centre button is seated, not raised

`app/(tabs)/_layout.tsx`. The frames draw the container at `y=-16`, so the
Blend'n button cleared the bar's top edge by 16pt. On a real screen that
**collides**: this CTA and the Pulse's filter control both end just above the
bar, and a button that leaves the bar overlaps them with its warm halo bleeding
onto them. `alignSelf: 'center'` seats it in the bar's content band instead.

The mark also went 28 → 34. `monogram-white.png` is 453×534, ink box 441×522,
and its strokes measure 22px and 30px across the middle row — **5.0% of the
mark's width**. At 28 that drew a 1.18pt line against roughly 2pt for every
other glyph in the bar: the lightest thing in the row while being the most
important control in it.

**For the designer, two asks that are drawing problems, not layout ones:**

1. **A filled variant of the monogram for small sizes.** 34pt gets the stroke to
   1.43pt, which is as far as scaling goes before the mark crowds its disc. An
   outline logo under 40pt cannot reach the weight of the glyphs beside it.
2. **The brand gradient and the UI gradient are different gradients.** Sampled
   from the artwork, the mark runs `#F04C16` → `#8F55A6` (orange → purple, 135°).
   `EMBER_GRADIENT` in the app is `#FF906D` → `#FF6D8D` (coral → pink) and never
   reaches purple. Both are in use. Which is canonical is an open question —
   nothing has been changed on the strength of it.

Also: **`Blend'n Logos-3.png` and `Blend'n Logos-5.png` still arrive blank** —
pure white 7800×7800, no alpha, no ink (`L min/max = 255,255`). These are the
knockout variants flattened onto white, and this is **already known and already
solved**: the app repo's `ROADMAP.md` (#55) records it, and
`scripts/extract-logo-alpha.py` recovers them exactly by inverting the
compositing. Noted here only because the source files handed over are still the
flattened ones, so anyone opening them cold sees two empty squares. Worth fixing
at the export rather than recovering forever.

The mark's tint is now `#1B1931`, sampled from the artwork: both the mono lockup
and the full lockup draw the mark in it, byte-identical. It was
`EMBER.onGradient` (`#5B1600`), which is the token for *text* on a gradient —
6.07:1 and a muddy maroon under a coral disc. The brand ink is 7.69:1.

### Contrast, measured

Every pair passes WCAG AA on `#0F0E0E`: `#AEAAAA` 8.38:1, accent `#FF906D`
8.69:1, white 19.28:1, amenity violet `#F79EFF` 10.36:1, amenity rose `#FF6D8D`
7.18:1.

### Dynamic type and VoiceOver — closed (app #177)

Both gaps this section used to record are fixed.

**There was no `maxFontSizeMultiplier` anywhere in the app.** React Native
**clips** a glyph to its `lineHeight` where CSS lets it overflow — the same
difference that made the frame's 43.2 leading on a 48pt font unusable here.
At Accessibility XXXL iOS scales by about 3.1×, which asks for a ~149pt
glyph inside a 56pt line: two rows of sliced letterforms over a photograph.
`numberOfLines` truncates and does not rescue the line box.

Capped at **1.2** on the hero title and **1.5** on the amenity tiles, which
live in a fixed 126pt box. Anything in a fixed-height container needs a cap;
anything in a growing one does not.

**VoiceOver.** Two fixes, both about announcements that were actively
misleading rather than merely missing:

- The hero caption was four separate fragments, two of them icon-plus-text
  pairs with stops that announce nothing. It is one `header` node now, so
  the rotor lands on it — "title, date, time, scarcity" in that order.
- The avatar row announced **"butterfly, turtle, fox"**. That is worse than
  silence: it is confidently wrong about what is on the screen. One image
  node, labelled with the count.

### The attendee discs carry a creature

The stack drew `pseudonymAvatar(...).initial`, which is `seed[0]` — and the
seed is the *event* id, so all three discs showed the same letter.

A varied letter would have been worse. **A letter on a disc reads as
somebody's initial**, and nobody's initial is what this is: the faces were
removed here precisely because a face is identity (#229). Inventing
initials re-adds a weaker version of that claim about people the payload
does not describe.

So: an animal, because the product already speaks in animals — the
pseudonyms it hands out are adjective-plus-creature ("Cosmic Panda",
"Velvet Heron"). **Deliberately not human characters**, which would carry
skin tone, hair, gender and age; three of those under "124 interested" at
an 18+ event is the demographic inference this stack exists to avoid.

**For the designer:** the frame draws two photographs and "+121". What
ships is three creature discs and "+121", at the frame's 56pt with its 4pt
`#0F0E0E` ring (`1141:4897`). If the frames want to show this, that is the
element to draw.

## Build order

1. Measure with `get_design_context`, one section at a time.
2. Restyle what exists — hero, pill, title, meta, body, location card.
3. Attendees as a **count**, pending the decision above.
4. Amenities and the map only once they have data behind them.
5. Verify each section on the simulator via the `__preview` harness before
   moving to the next, as the Pulse work now does.
