"use client"

/**
 * What this picture actually looks like in the app.
 *
 * ## The problem it exists for
 *
 * One square upload has to fill three slots with three different shapes
 * (`docs/MEDIA.md`, measured off frame `1141:4644`):
 *
 * | Slot | Points | Aspect |
 * |---|---|---|
 * | Featured card | 331.5 × 450 | **0.737** — portrait |
 * | Upcoming card | 318 × 165.38 | **1.923** — a wide band |
 * | Nearby large | 366 × 342 | **1.070** — near square |
 *
 * The widest is 2.6× the aspect of the tallest, so **no single crop fills
 * both**: one keeps the full height and loses the sides, the other keeps the
 * full width and loses half the height. The region surviving *every* crop is
 * the centre **73.7% × 52%**.
 *
 * Telling an organiser "73.7% by 52%" is a number. Showing them their own
 * poster with the title sliced off is a correction they only need once — which
 * is the entire reason this component exists rather than another paragraph of
 * guidance.
 *
 * ## Why the crops are computed here rather than by CSS `object-fit`
 *
 * `object-fit: cover` centre-crops, which is what the app does — but it gives
 * no way to *draw the safe area on top* in the master's own coordinates. These
 * are explicit percentages so the overlay and the crop are derived from the
 * same two numbers and cannot drift.
 */

const SAFE_W = 0.737
const SAFE_H = 0.52

/** The three slots, at the aspect each one crops the square master to. */
const SLOTS = [
  {
    key: "featured",
    label: "Featured card",
    note: "Keeps the full height, loses 26% of the width",
    aspect: 331.5 / 450,
  },
  {
    key: "upcoming",
    label: "Upcoming card",
    note: "Keeps the full width, loses 48% of the height",
    aspect: 318 / 165.38,
  },
  {
    key: "nearby",
    label: "Nearby card",
    note: "Near square — loses least",
    aspect: 366 / 342,
  },
] as const

export function DevicePreview({ src }: { src?: string | null }) {
  if (!src) return null

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <div>
        <p className="text-sm font-medium">How this looks in the app</p>
        <p className="text-xs text-muted-foreground">
          The same picture, cropped as each card crops it. The dashed box is the
          area that survives <strong>all three</strong> — keep faces, titles and
          logos inside it.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {SLOTS.map((slot) => (
          <figure key={slot.key} className="space-y-1">
            <div
              className="relative w-full overflow-hidden rounded-md border bg-black"
              style={{ aspectRatio: String(slot.aspect) }}
            >
              {/*
                `object-cover` centre-crops exactly as the app does. A plain
                `<img>` rather than `next/image`: the source is a Tigris URL or
                a blob from a picker that has not been uploaded yet, and
                `next/image` would want both configured.
              */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt={`${slot.label} crop`}
                className="absolute inset-0 h-full w-full object-cover"
              />
              {/*
                The safe area, in the *master's* coordinates projected into
                this crop. Horizontally the featured slot already cuts to
                73.7%, so the box spans the full width there; the arithmetic
                below is what keeps one overlay honest across three aspects.
              */}
              <SafeArea aspect={slot.aspect} />
            </div>
            <figcaption className="text-[11px] leading-tight text-muted-foreground">
              <span className="block font-medium text-foreground">{slot.label}</span>
              {slot.note}
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  )
}

/**
 * The dashed safe-area box, drawn over one crop.
 *
 * The master is square. A slot with aspect `a` shows, of that square:
 *
 * - `a >= 1` (wide): the full width, and `1/a` of the height.
 * - `a < 1` (tall): the full height, and `a` of the width.
 *
 * So the safe box — `SAFE_W × SAFE_H` of the *master* — occupies
 * `SAFE_W / shownWidth` by `SAFE_H / shownHeight` of this crop, clamped at 1
 * because a slot can crop tighter than the safe area on one axis and then the
 * box is simply the whole edge.
 */
function SafeArea({ aspect }: { aspect: number }) {
  const shownW = aspect >= 1 ? 1 : aspect
  const shownH = aspect >= 1 ? 1 / aspect : 1

  const w = Math.min(1, SAFE_W / shownW)
  const h = Math.min(1, SAFE_H / shownH)

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute border-2 border-dashed border-white/70"
      style={{
        left: `${((1 - w) / 2) * 100}%`,
        top: `${((1 - h) / 2) * 100}%`,
        width: `${w * 100}%`,
        height: `${h * 100}%`,
      }}
    />
  )
}
