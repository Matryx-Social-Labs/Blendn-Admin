# Media — what organizers upload, and what the app draws

One upload has to land in five cards of different shapes. This file is the
arithmetic behind that, so that the organizer guidance, the seed data and the
dashboard's preview all quote the same numbers instead of three people each
rounding differently.

## The cards, in points

From the redesign (pulse-media board 13), as the app draws them today:

| Card | Points | Fit |
|---|---|---|
| Pulse lead | 345 × 256 | a clip fills it; a still by rule B |
| Event hero | 345 × 345 | a clip fills it; a still by rule B |
| Venue hero | 393 × 300 | a clip fills it; a still by rule B |
| Thumb | 64 × 64 | a clip fills it; a still by rule B |
| Story card | 1080 × 1920 | the picture whole, always (the share image) |

`MEDIA_CARDS` in `lib/media-fit.ts` holds these; `__tests__/media-fit.test.ts`
fails if the two disagree.

## How a picture is fitted

- **Stills, fit rule B (owner 2026-11-17).** A still is cropped only when its
  ratio is within **±15%** of the card's. Otherwise it is shown **whole**, over a
  blurred, dimmed copy of itself, never another picture. A flyer is never cut.
  (`fitFor` in the app's `components/ds/LinkPreviewCard.tsx`, and in
  `lib/media-fit.ts` here.)
- **Clips fill every card (owner 2026-11-18)**, cropped to the card's shape, as
  Instagram, Netflix, Airbnb and TikTok do. No bars, no blur.
- **The crop keeps the focal point in view (SCRUM-1106).** `event_media.focal_x`
  / `focal_y`, 0–1 of the picture from its left and top, both or neither
  (`event_media_focal_both`). The organizer clicks the subject in the dashboard.
  With no point the app crops at **50% across, 40% down**, because faces sit
  high. The crop puts the point as near the card's centre as the picture allows
  and never shows past its edge (`focusPosition`).

So a square master is never cut on a still: it is within 15% of the hero and the
thumb, which are square, and further than that from the lead and venue hero,
which then show it whole. A still only needs a focal point when its own shape is
close to, but not the same as, a card's (a 4:3 photo in the 345 × 256 lead).
The dashboard shows the picker only then, and always for a clip.

## The dashboard's preview

Every gallery item, and the cover, draws the upload in all five cards beside the
field, each saying whether it is cropped at the point or shown whole
(`components/event-form/media-fit-preview.tsx`, option A per advisor,
board `pulse-media/t30-focal/`). Telling an organizer "within 15%" is a number;
showing them their own photo in the card is a correction they need only once.

### Why square

Square is the shape organizers already have: every social platform accepts it,
so it is the one asset a venue is most likely to own without commissioning
anything. And rule B shows it whole wherever it does not fit, so it is never cut.

## Pixels

At @3x, the largest card is the venue hero, 393 × 300 points: 1179 × 900 pixels.
A square master must be at least that wide to fill it without upscaling.

| | |
|---|---|
| **Minimum** | 1600 × 1600 |
| **Recommended** | 2048 × 2048 |
| Format | JPEG or PNG; JPEG for photographs |
| Max file size | 8 MB |

The minimum leaves room over the 1179 pixels the widest card needs; an upscaled
photograph on the lead card is the most visible quality failure in the product —
it is the first thing anybody sees.

## Video

Clips play **inside** the cards, over the still, and fill each card, cropped
around the focal point (above).

| | |
|---|---|
| Aspect | 1:1 |
| Resolution | 1080 × 1080 |
| Duration | ≤ 15 s |
| Codec | H.264 (High), AAC audio |
| Container | MP4 with **faststart** |
| Max file size | 12 MB |

### The poster must be the clip's own first frame

Not merely *a* still. Every surface paints the poster and mounts the player over
it, so when the poster is a different picture the instant the clip produces its
first frame the image changes — the screen settles and then visibly re-settles.
Preloading removes the *wait* and does nothing about the *jump*.

The dashboard takes care of this: uploading a video decodes its opening frame in
the browser and stores it as `thumbnail_url` (`lib/video-poster.ts`). It samples
at 0.1s rather than 0, because seeking to exactly zero returns a pre-keyframe
frame on some encoders — black, or a smear of macroblocks.

A clip added by **URL** cannot be read this way: the canvas is tainted
cross-origin and `toBlob` throws. Those need a poster pasted by hand, and the
form says so.

### What the clients do, and why

| | |
|---|---|
| Poster underneath until the first frame | A buffering clip shows its own still, never a black rectangle. The hero unmounts it once the clip draws (it is `contain`, so a poster left under a letterboxed clip shows in the bars: SCRUM-1066) |
| One player at a time | A *paused* player still holds a decoder. The feed mounts only the active card; the lightbox only the visible page |
| The hero preloads one page either side | Mounting on arrival meant open, buffer and first-frame all began after the swipe landed. Bounded to one extra decoder — a hero has one playlist, unlike a feed |
| Posters carry `recyclingKey` | Without it `expo-image` can hand a page a recycled view still holding the previous picture |
| No cross-fade in a pager | The slide is the transition. A fade on top of it shows two pictures at once |
| Muted in feed and hero, sound in the lightbox | Opening the lightbox is a deliberate act; scrolling past a card is not |

**Faststart is not optional.** Without the moov atom at the front the player
must fetch the end of the file before it can show a frame, which on a feed means
the card sits on its poster for an extra round trip on every scroll past.

**Short MP4, not HLS.** A ten-second loop does not earn an adaptive ladder — the
manifest, the segmenter and the multiple renditions all cost more than they save
at this length. Revisit if long-form video ever ships.

**Every row says its size (SCRUM-1066).** `event_media.width`, `height` and,
for a clip, `duration_ms`, measured by the dashboard from the picked file before
it uploads (`lib/media-size.ts`) and sent on `GET /events` and
`GET /events/:eventId`. The app chooses a card's fit from them before the bytes
land, and times the Featured lap from `duration_ms`. A clip over 15 s is refused
at the pick and again on save, with 500 ms of tolerance for an export's padding
(`MEDIA.CLIP_TOLERANCE_MS`); the measured length is stored unclamped. A pasted URL has no size (a typed URL clears the
measured one), and nor do rows from before: the app measures on load for those.

**A poster is expected, and is never the cover.** `event_media.thumbnail_url`
should be set for a video row: it is what shows while the first frame decodes.
`lib/feedMedia.ts` uses it and nothing else — the event's cover is another
picture at another ratio, and it showed around a letterboxed clip (SCRUM-1066).
A clip with no poster shows the frame's dark surface until it plays. Extract
frame 0 at upload time.

**Muted, looping, one at a time.** The feed never plays sound; only the card the
viewport has settled on mounts a player. See `FeedVideo` in the app repo for why
that is mount/unmount rather than play/pause.

## Where these numbers are used

| | |
|---|---|
| `components/event-form/cover-image-section.tsx` | Cover guidance. **Pinned by `__tests__/media-guidance.test.ts`** |
| `components/event-form/media-section.tsx` | Gallery guidance, the poster field, and the file picker's `accept`. Same test |
| `scripts/seed-*.ts` | Seeded events must carry assets at these sizes, or staging tests the wrong thing |
| `components/event-form/media-fit-preview.tsx` | Draws the upload in the five cards and takes the focal point. Its numbers are `lib/media-fit.ts`, **pinned by `__tests__/media-fit.test.ts`** — a preview that crops differently from the phone is worse than none, because an organizer trusts it and composes to it |
| `lib/feedMedia.ts` (app) | Chooses the asset; enforces the poster rule |

If any of them disagrees with this file, this file is what the app actually
does — check it against the frame before changing it.

The first two are no longer on trust: `__tests__/media-guidance.test.ts` reads
the Recommended and Minimum rows out of *this file* and fails if the form quotes
different numbers. That test exists because the cover field advised
`1200×630` — a landscape OG ratio — for however long it took someone to notice,
which is the exact failure mode a spec nothing checks against is prone to.

## For the designer

Two things the frames should assume, because the code now enforces them:

**A clip without a poster shows a dark frame until it plays.** `feedPlaylist`
takes the clip's own `thumbnail_url` and never the event's cover (SCRUM-1066),
so any frame showing video is also, implicitly, a frame requiring its own still
behind it. The organizer form asks for the poster and says so.

**Square masters, and the whole picture.** A still is cropped only within 15%
of a card's shape and otherwise shown whole over a blurred copy of itself, so a
frame should never assume a landscape still fills a square card. A clip always
fills, cropped around the organizer's focal point.
