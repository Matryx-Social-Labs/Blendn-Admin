# Media — what organisers upload, and what the app draws

One asset per event has to fill three slots with three different shapes. This
file is the arithmetic behind the answer, so that the organiser guidance, the
seed data and the dashboard's preview all quote the same numbers instead of
three people each rounding differently.

## The three slots, measured

From frame `1141:4644`, not from a guess:

| Slot | Points | Aspect |
|---|---|---|
| Featured card | 331.5 × 450 | **0.737** — portrait |
| Upcoming card image | 318 × 165.38 | **1.923** — a wide band |
| Nearby large | 366 × 342 | **1.070** — near square |

That spread is the whole problem. The widest slot is 2.6× the aspect of the
tallest one, and **no single crop of a single asset can fill both** — one keeps
the full height and loses the sides, the other keeps the full width and loses
half the height.

## The answer: a square master, and a published safe area

Organisers upload **one square image**. The app centre-crops it per slot.

- The portrait slot keeps the full height and crops to **73.7%** of the width.
- The wide slot keeps the full width and crops to **52%** of the height.

So the region that survives **every** crop is the centre **73.7% × 52%**.

```
┌─────────────────────────┐  ← square master
│         cropped         │
│   ┌─────────────────┐   │
│   │   SAFE AREA     │   │  73.7% of width
│   │  73.7% × 52%    │   │  52% of height
│   └─────────────────┘   │
│         cropped         │
└─────────────────────────┘
```

**Anything that must be legible — a face, a headline, a logo, a date — belongs
inside the safe area.** Outside it, the asset is decoration that some slots show
and others do not.

This is what the dashboard's device preview exists to make obvious. Telling an
organiser "73.7% by 52%" is a number; showing them their own poster with the
title sliced off is a correction they only need once.

### Why square rather than 2:1

Eventbrite asks for 2:1 at 2160×1080, and every banner-shaped platform asks for
something similar — because a banner is the only shape they draw. We draw a
portrait card as the *hero*, so a 2:1 upload would arrive 1.9× too wide for the
most prominent slot on the screen and lose two thirds of itself to the crop.

Square is also the shape organisers already have. Every social platform accepts
it, so it is the one asset a venue is most likely to own without commissioning
anything.

## Pixels

At @3x on a 440pt phone — the largest we currently render:

| Slot | Points | Pixels |
|---|---|---|
| Featured | 374 × 508 | 1122 × **1524** |
| Nearby large | 392 × 366 | 1176 × 1098 |
| Upcoming | 344 × 179 | 1032 × 537 |

The binding number is **1524** — the Featured card's height, which comes from
the master's *full* height because that slot crops width only.

| | |
|---|---|
| **Minimum** | 1600 × 1600 |
| **Recommended** | 2048 × 2048 |
| Format | JPEG or PNG; JPEG for photographs |
| Max file size | 8 MB |

Below 1600 the hero card upscales, and an upscaled photograph on a 450pt card is
the most visible quality failure in the product — it is the first thing anybody
sees.

## Video

Clips play **inside** the cards, over the still. Same three slots, same crops,
so the same square master and the same safe area apply.

| | |
|---|---|
| Aspect | 1:1 |
| Resolution | 1080 × 1080 |
| Duration | ≤ 15 s |
| Codec | H.264 (High), AAC audio |
| Container | MP4 with **faststart** |
| Max file size | 12 MB |

**Faststart is not optional.** Without the moov atom at the front the player
must fetch the end of the file before it can show a frame, which on a feed means
the card sits on its poster for an extra round trip on every scroll past.

**Short MP4, not HLS.** A ten-second loop does not earn an adaptive ladder — the
manifest, the segmenter and the multiple renditions all cost more than they save
at this length. Revisit if long-form video ever ships.

**A poster is required.** `event_media.thumbnail_url` must be set for a video
row. `lib/feedMedia.ts` refuses to play a clip it cannot poster, because the
still is what the card shows while the first frame decodes — without one, the
card is a black rectangle for the length of a round trip on a card that would
have looked finished as a photograph. Extract frame 0 at upload time.

**Muted, looping, one at a time.** The feed never plays sound; only the card the
viewport has settled on mounts a player. See `FeedVideo` in the app repo for why
that is mount/unmount rather than play/pause.

## Where these numbers are used

| | |
|---|---|
| Organiser guidance | The upload control in the dashboard |
| `scripts/seed-*.ts` | Seeded events must carry assets at these sizes, or staging tests the wrong thing |
| Dashboard device preview | Renders the real crops with the safe area drawn on |
| `lib/feedMedia.ts` (app) | Chooses the asset; enforces the poster rule |

If any of them disagrees with this file, this file is what the app actually
does — check it against the frame before changing it.
