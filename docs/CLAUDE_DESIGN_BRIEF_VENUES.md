# Blend'n — venue creation, claiming, and verification

Paste into Claude Design. Three flows that the previous round referenced but did
not design.

---

## What's missing, precisely

The venue screens are built and good. Two buttons on them lead nowhere, and one
sentence describes a flow that does not exist:

| Where | What it says | What happens |
|---|---|---|
| `screen-venues-admin.jsx` | **"Add venue"** button | nothing |
| `screen-venues-admin.jsx` | **"Assign owner"** on unclaimed rows | nothing |
| `screen-venues-admin.jsx` | empty state: *"A venue record is created when an owner claims their place or an admin adds one"* | neither flow is designed |
| `screen-myvenues.jsx` | empty state: *"Link the venues you operate"* | no way to |

So: **no venue has ever been created in this product.** The table exists, the
detail page exists, the permission resolver reads it — and nothing writes to it.
Every `/dashboard/venues/[id]` currently 404s.

---

## Why this matters more than a CRUD form

A venue is not a row someone types. It carries **operational control over other
people's events.**

When an organiser picks a claimed venue, the event auto-links immediately and
the venue's owner gets the chatroom, moderation and the attendee list for an
event that is not theirs. They were not asked first — they find out because it
appears on their dashboard, and they can dispute it.

That is the right design (a venue owner controls what happens in their
building), and it means **a false claim is an access-control failure**, not a
data-quality one. Someone who claims Byg Brewski gets to moderate Byg Brewski's
events.

So the question the design has to answer is not "how do we collect a venue" but
**"how do we make claiming a place you don't own hard enough not to bother, and
reversible when it happens anyway."**

---

## Design these four

### 1. Create a venue — staged, like the event editor

Reachable by an admin (from Venues) and by a venue owner (from My venues).

Stages: **Basics** (name, type) → **Location & geofence** → **Capacity &
details** → **Review**.

**Venue type is a new field** and needs a picker. 35 values, grouped — do not
render them flat:

- *Food & drink* — restaurant, pub/bar, brewery, café, lounge/rooftop
- *Nightlife* — nightclub, live music venue
- *Events & hospitality* — banquet hall, convention centre, conference centre, hotel, resort, farmhouse
- *Sport* — stadium, sports complex, gym/fitness studio
- *Culture* — theatre, cinema, art gallery, museum, amphitheatre
- *Community* — community hall, co-working, campus, school, library, religious venue
- *Open air* — park/ground, beach/waterfront, terrace
- *Other* — studio, warehouse, retail/mall, private residence, other

The **geofence stage reuses the editor that already ships** — circle or traced
polygon, buffer ring, GPS allowance ring, one-click "use building outline" from
OpenStreetMap. Do not redesign it; show how it sits inside this flow. A venue's
geofence is inherited by every event held there, so this is the one place it
should be drawn well.

### 2. The duplicate check — the most important screen here

**Before anything is created, search for what already exists nearby.**

Once the pin is placed, look for venues within ~100 m and show them. If the
place is already on the platform, the correct action is **claim it**, not create
a second record. Two records for one building is how "The Loft" and "the loft"
become two venues with split history and two owners.

Design that moment: "We already know this place" with the match, its address,
whether it is claimed, and one obvious action. Creating anyway must be possible
but should be the quieter path — a genuinely different room in the same complex
is a real case.

### 3. Claiming a venue — with evidence

A venue owner says "this is mine". Design the claim form and the review that
follows.

Reuse the **onboarding review queue** pattern that already ships for organiser
applications — it works, admins know it, and it is the right shape.

Evidence to collect, India-specific:
- **Trade licence** or shop & establishment registration
- **GSTIN** with an address matching the venue
- **FSSAI licence** for anywhere serving food
- **Liquor licence** for a bar or club
- Optional: a photo of the frontage, or the Google Business Profile

Nothing here can be auto-verified — exactly like GSTIN, which this product
validates by checksum only and labels *"Not verified as registered."* **A human
decides.** Design the queue row so an admin can decide quickly: what was
claimed, what evidence came with it, and whether anything looks off.

Three states to design: submitted, approved, declined-with-reason.

### 4. Claiming something already owned = a dispute

If a venue already has an owner, a second claim is not a claim. Design that
divergence: what the claimant sees, what the current owner is told, and how an
admin resolves it.

---

## The safeguards, stated so the design can express them

Four layers. The design should make the first two visible and the last two
legible when they fire:

1. **Proximity dedup** — you cannot silently create a second record for a
   building that already exists.
2. **Admin review with evidence** — physical ownership needs a human.
3. **One owner per venue** — a second claim is a dispute.
4. **Auto-link is reversible** — the owner can unlink any event they did not
   agree to, with a reason, audited.

Layer 4 is why layers 1–3 do not need to be bulletproof: the damage a false
claim can do is bounded and undoable. Say that in the UI rather than implying
the check is stronger than it is.

---

## Also design

**The unclaimed venue.** Most venues will have no owner. Design the state: an
admin created it, or an organiser's free-text location was matched to it. It
works fine — events there simply carry no venue-owner access. This is the common
case, not a gap to nag about.

**"Assign owner"** from the admin table — the admin-side counterpart to a claim,
for when an owner is handled over email instead.

---

## Constraints (these bit previous rounds)

- **GPS check-in has no off switch.** A previous round designed one; physical
  presence is the product. Every venue has a geofence.
- **Do not invent data.** Design only against fields that exist. Venues have:
  name, type, address, city, latitude, longitude, capacity, geofence, owner,
  claimed_at, status.
- **Satoshi has no 600 weight.** 300/400/500/700/900 only.
- **Container queries** (`@sm/main:`, `@3xl/main:`), never viewport breakpoints.
- **No `dialog` primitive** — inline confirmations or a sheet.
- **Dark-first.** The map is light; that seam needs deliberate handling.
- **Empty is the common case** — the venues table is currently empty in every
  environment.
- One `h1` per page, owned by the top bar. Icons outlined.

---

## Deliver

1. The staged **create-venue flow**, with the grouped type picker and the
   geofence stage.
2. The **proximity duplicate check** — the screen that turns a create into a
   claim.
3. The **claim form and its review queue row**, in three states.
4. The **dispute** divergence when the venue is already owned.
5. The **unclaimed venue** state and **"Assign owner"**.
6. A component sheet for anything new.

Match the shipped dashboard — `docs/DESIGN_SYSTEM.md` and the earlier briefs in
`docs/` are the reference.
