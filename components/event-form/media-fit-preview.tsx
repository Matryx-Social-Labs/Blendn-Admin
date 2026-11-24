"use client"

import { useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react"
import { Button } from "@/components/ui/button"
import {
  cardFit,
  cropsWithSlack,
  DEFAULT_FOCUS,
  focalPoint,
  focusPosition,
  MEDIA_CARDS,
  type FocalPoint,
  type MediaCard,
  type MediaSize,
} from "@/lib/media-fit"

/**
 * The upload in the app's five cards, and where its subject is (SCRUM-1106,
 * queue task 30, option A per advisor, board `pulse-media/t30-focal/`).
 *
 * Replaces the device preview, which drew three cards the redesign deleted and
 * always centre-cropped. The fit is the app's (`lib/media-fit.ts`): a clip
 * fills every card around the point, a still is cropped only within 15% of the
 * card's shape and otherwise shown whole over a blurred copy of itself.
 *
 * The picker shows only when a card actually crops something (always for a
 * clip; for a still, rarely: a square master is never cut). It sits on the
 * upload's own picture: one click or drag sets the point, and the ring is one
 * focusable control (arrows 5%, Shift 1%, Home clears it).
 */

/** The cards are drawn at this fraction of their size in points; the 64 thumb at 1:1, or it is unreadable. */
const SCALE = 0.6
/** The Story share card, drawn 108 wide: the cover sits at (64, 330), 952 square, in its 1080 × 1920 (the app's `StoryCard`). */
const STORY = { width: 108, cover: { left: 6.4, top: 33, side: 95.2 } }
const STEP = 0.05
const FINE_STEP = 0.01

interface MediaFitPreviewProps {
  src: string
  type: "image" | "video"
  /** A clip's poster: the picker and the cards draw it rather than decoding the clip. */
  poster?: string | null
  /** Measured on upload; read from the picture when it loads otherwise (a pasted URL). */
  size?: MediaSize | null
  focal?: FocalPoint | null
  /** Absent: the cards only, no point to pick (the cover has no column for one). */
  onFocalChange?: (point: FocalPoint | null) => void
}

export function MediaFitPreview({ src, type, poster, size, focal, onFocalChange }: MediaFitPreviewProps) {
  const [loaded, setLoaded] = useState<{ src: string; size: MediaSize } | null>(null)
  const picture = type === "video" && poster ? poster : src
  const known = size ?? (loaded?.src === picture ? loaded.size : null)
  const drawsVideo = type === "video" && !poster
  const showPicker = !!onFocalChange && !!known && cropsWithSlack(known, type)

  const measure = (width: number, height: number) => {
    if (width > 0 && height > 0) setLoaded({ src: picture, size: { width, height } })
  }

  return (
    // Sized by its own width: a gallery item sits in a narrow form column, where the cards go under the picker.
    <div className="@container space-y-3 rounded-lg border bg-muted/30 p-4">
      {!known && (
        <>
          <p className="text-xs text-muted-foreground">Preview appears once the picture loads.</p>
          {/* Read the size of a pasted URL; nothing is drawn until it is known, because a guessed ratio would lie. */}
          <Picture
            src={picture}
            video={drawsVideo}
            className="hidden"
            onSize={measure}
          />
        </>
      )}
      {known && (
        <div className={showPicker ? "grid gap-5 @3xl:grid-cols-[minmax(0,340px)_1fr]" : undefined}>
          {showPicker && (
            <Picker
              picture={picture}
              video={drawsVideo}
              type={type}
              focal={focal ?? null}
              onChange={onFocalChange}
            />
          )}
          <div className="space-y-2">
            <p className="text-sm font-medium">How it lands in the app</p>
            <div className="flex flex-wrap items-end gap-4">
              {MEDIA_CARDS.map((card) => (
                <Card
                  key={card.key}
                  card={card}
                  picture={picture}
                  video={drawsVideo}
                  fit={cardFit(card, known, type)}
                  position={focusPosition(known, card, focal ?? null)}
                />
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {showPicker
                ? "Cards that fill crop around your point. A picture far from a card's shape is shown whole there, never cut."
                : type === "image"
                  ? "Nothing is cut. Every card shows this picture whole."
                  : null}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

function Picker({
  picture,
  video,
  type,
  focal,
  onChange,
}: {
  picture: string
  video: boolean
  type: "image" | "video"
  focal: FocalPoint | null
  onChange: (point: FocalPoint | null) => void
}) {
  const [dragging, setDragging] = useState(false)
  const at = focal ?? DEFAULT_FOCUS

  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    onChange({ x: focalPoint((e.clientX - box.left) / box.width), y: focalPoint((e.clientY - box.top) / box.height) })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? FINE_STEP : STEP
    const move: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }
    if (e.key === "Home") {
      e.preventDefault()
      onChange(null)
      return
    }
    const d = move[e.key]
    if (!d) return
    e.preventDefault()
    onChange({ x: focalPoint(at.x + d[0]), y: focalPoint(at.y + d[1]) })
  }

  const percent = (v: number) => Math.round(v * 100)

  return (
    <div className="max-w-[340px] space-y-2">
      <p className="text-sm font-medium">Subject</p>
      <div
        role="slider"
        tabIndex={0}
        aria-label="Subject position"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent(at.x)}
        aria-valuetext={focal ? `x ${percent(at.x)}%, y ${percent(at.y)}%` : "Not set: the center, a little high"}
        className="relative cursor-crosshair touch-none overflow-hidden rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onKeyDown={onKeyDown}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          setDragging(true)
          fromPointer(e)
        }}
        onPointerMove={(e) => dragging && fromPointer(e)}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
      >
        <Picture src={picture} video={video} className="block h-auto w-full select-none" />
        <span
          aria-hidden
          className={`pointer-events-none absolute size-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white shadow-[0_0_0_2px_rgb(0_0_0/0.55)] ${focal ? "" : "opacity-60"}`}
          style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
        >
          <span className="absolute left-1/2 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white" />
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Click the part that must stay in view.{" "}
        {type === "video" ? "Clips fill every card, so each one crops at this point." : "Every card that crops keeps this point in frame."}
      </p>
      {focal && (
        <Button type="button" variant="outline" size="sm" onClick={() => onChange(null)}>
          Reset point
        </Button>
      )}
    </div>
  )
}

function Card({
  card,
  picture,
  video,
  fit,
  position,
}: {
  card: MediaCard
  picture: string
  video: boolean
  fit: "cover" | "contain"
  position: FocalPoint
}) {
  const story = !!card.whole
  const scale = card.key === "thumb" ? 1 : story ? STORY.width / card.width : SCALE
  const width = card.width * scale
  const height = card.height * scale

  return (
    <figure className="space-y-1">
      <div className="relative overflow-hidden rounded-md border bg-black" style={{ width, height }}>
        {story ? (
          <>
            <Picture src={picture} video={video} className="absolute inset-0 size-full scale-110 object-cover blur-md brightness-50" />
            <div
              className="absolute overflow-hidden rounded-sm"
              style={{ left: STORY.cover.left, top: STORY.cover.top, width: STORY.cover.side, height: STORY.cover.side }}
            >
              <Whole picture={picture} video={video} />
            </div>
          </>
        ) : fit === "cover" ? (
          <Picture
            src={picture}
            video={video}
            className="absolute inset-0 size-full object-cover"
            style={{ objectPosition: `${position.x}% ${position.y}%` }}
          />
        ) : (
          <Whole picture={picture} video={video} />
        )}
      </div>
      <figcaption className="text-[11px] leading-tight text-muted-foreground">
        <span className="block font-medium text-foreground">{card.label}</span>
        {Math.round(card.width)} × {Math.round(card.height)}
        <span className="block">{fit === "cover" ? "Fills the card" : "Shown whole"}</span>
      </figcaption>
    </figure>
  )
}

/** Rule B's contained fill: the whole picture over a blurred, dimmed copy of itself, never another picture. */
function Whole({ picture, video }: { picture: string; video: boolean }) {
  return (
    <>
      <Picture src={picture} video={video} className="absolute inset-0 size-full scale-110 object-cover blur-md brightness-50" />
      <Picture src={picture} video={video} className="absolute inset-0 size-full object-contain" />
    </>
  )
}

/**
 * A still, or a clip's opening frame when it has no poster yet (`#t=0.1`, as
 * `lib/video-poster.ts` samples: frame 0 is black on some encoders). Muted and
 * metadata-only, so a form never makes noise or pulls a whole clip.
 */
function Picture({
  src,
  video,
  className,
  style,
  onSize,
}: {
  src: string
  video: boolean
  className?: string
  style?: CSSProperties
  onSize?: (width: number, height: number) => void
}) {
  if (video) {
    return (
      <video
        src={`${src}#t=0.1`}
        muted
        playsInline
        preload="metadata"
        aria-hidden
        className={className}
        style={style}
        onLoadedMetadata={(e) => onSize?.(e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
      />
    )
  }
  return (
    // A plain <img>: the source is a Tigris URL or a pasted one, which `next/image` would want configured.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      draggable={false}
      className={className}
      style={style}
      onLoad={(e) => onSize?.(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
    />
  )
}
