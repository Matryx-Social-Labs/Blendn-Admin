"use client"

import Image from "next/image"
import { IconCircleCheck } from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import type { Readiness, ReadinessField } from "@/lib/event-readiness"

/**
 * The rail is the event becoming real.
 *
 * The card fills in as the organiser types — title, the one line, the cover,
 * the first category — the readiness list shrinks item by item beneath it,
 * and Publish turns orange the moment the last item goes. It is the only
 * brand-orange thing on the screen, and it is earned.
 *
 * It replaces a readiness strip at the top of a 6,384px form and a submit
 * button at the very bottom of it: two answers to "can this publish yet",
 * neither visible from where the organiser was actually typing.
 */

/** Where each readiness item's link scrolls to. Sections own these ids. */
export const READINESS_ANCHORS: Record<ReadinessField, string> = {
  title: "field-title",
  start_time: "field-start_time",
  end_time: "field-end_time",
  location: "step-where",
  check_in_radius: "step-where",
  timezone: "field-timezone",
  category_ids: "field-category_ids",
  cover_image_url: "field-cover",
}

/**
 * `next/image` throws on a URL it cannot parse, and the cover field is typed
 * one character at a time — "h", "ht", "htt" — before it is a URL at all.
 */
export function renderableImageUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const u = new URL(value)
    return u.protocol === "http:" || u.protocol === "https:" ? value : null
  } catch {
    return null
  }
}

export interface CardPreviewProps {
  title: string
  line: string
  coverUrl: string
  category: string
  when: string
}

export function CardPreview({ title, line, coverUrl, category, when }: CardPreviewProps) {
  const src = renderableImageUrl(coverUrl)
  return (
    <figure
      // The featured card at 224px wide is 304px tall: the list and the buttons
      // stay above the fold on a 13-inch laptop, which is the point of the rail.
      className="relative aspect-[331.5/450] w-56 overflow-hidden rounded-2xl border border-border bg-muted"
      aria-label="How this looks on the Pulse"
    >
      {src ? (
        <Image
          src={src}
          alt=""
          fill
          unoptimized
          sizes="224px"
          className="object-cover"
        />
      ) : null}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(to top, rgba(13,12,12,.92) 0%, rgba(13,12,12,.35) 45%, transparent 70%)",
        }}
        aria-hidden
      />
      <figcaption className="absolute inset-x-4 bottom-3 flex flex-col gap-1.5">
        {category ? (
          <span className="w-fit rounded-md bg-background/70 px-2 py-1 text-[0.7rem] font-bold uppercase tracking-[0.08em] text-primary">
            {category}
          </span>
        ) : null}
        <span className="text-[1.05rem] font-bold leading-[1.1] tracking-[-0.02em] text-foreground">
          {title || <span className="text-muted-foreground">Untitled event</span>}
        </span>
        <span className="truncate text-[0.7rem] text-muted-foreground">
          {[when, line].filter(Boolean).join(" · ") || "The one line for the card shows here"}
        </span>
      </figcaption>
    </figure>
  )
}

export interface PublishRailProps {
  readiness: Readiness
  card: CardPreviewProps
  isEditing: boolean
  isSubmitting: boolean
  /** The event's stored status when editing; "draft" on create. */
  status: "draft" | "published" | "cancelled" | "completed"
  onSaveDraft: () => void
  onPublish: () => void
  onSaveChanges: () => void
  onCancelEvent: () => void
}

function ReadinessList({ readiness }: { readiness: Readiness }) {
  const { blockers, warnings } = readiness
  if (blockers.length === 0 && warnings.length === 0) {
    return (
      <p className="flex items-center gap-2 text-[0.8125rem] text-success">
        <IconCircleCheck className="size-4 shrink-0" aria-hidden />
        Everything the app needs is here.
      </p>
    )
  }
  return (
    <ul className="flex flex-col gap-1.5 text-[0.8125rem]">
      {blockers.map((item) => (
        <li key={item.message} className="flex items-start gap-2">
          <span
            className="mt-[6px] size-2 shrink-0 rounded-full border-[1.5px] border-warning"
            aria-hidden
          />
          <a
            href={`#${READINESS_ANCHORS[item.field]}`}
            className="underline decoration-border-strong underline-offset-[3px] hover:decoration-foreground"
          >
            {item.message}
          </a>
        </li>
      ))}
      {warnings.map((item) => (
        <li key={item.message} className="flex items-start gap-2 text-muted-foreground">
          <span
            className="mt-[6px] size-2 shrink-0 rounded-full border-[1.5px] border-faint-foreground"
            aria-hidden
          />
          <a
            href={`#${READINESS_ANCHORS[item.field]}`}
            className="underline decoration-border underline-offset-[3px] hover:decoration-foreground"
          >
            {item.message}
          </a>
        </li>
      ))}
    </ul>
  )
}

function Actions({
  readiness,
  isEditing,
  isSubmitting,
  status,
  onSaveDraft,
  onPublish,
  onSaveChanges,
  onCancelEvent,
  compact = false,
}: Omit<PublishRailProps, "card"> & { compact?: boolean }) {
  const blocked = readiness.blockers.length > 0
  const live = isEditing && status === "published"
  const cancelled = isEditing && status === "cancelled"
  const left = readiness.blockers.length
  const why = blocked
    ? `${left} thing${left === 1 ? "" : "s"} left before it can publish`
    : null

  return (
    <div className={compact ? "flex items-center gap-2" : "flex flex-col gap-2"}>
      {live ? (
        <Button type="button" onClick={onSaveChanges} disabled={isSubmitting || blocked} className={compact ? "" : "w-full"}>
          {isSubmitting ? "Saving…" : "Save changes"}
        </Button>
      ) : (
        <Button
          type="button"
          // Grey until the list is empty: a dimmed orange still reads as orange,
          // and the orange is meant to be earned.
          variant={blocked || cancelled ? "secondary" : "default"}
          onClick={onPublish}
          disabled={isSubmitting || blocked || cancelled}
          aria-describedby={why ? "publish-why" : undefined}
          className={compact ? "" : "w-full"}
        >
          {isSubmitting ? "Saving…" : "Publish"}
        </Button>
      )}
      {why && !compact ? (
        <p id="publish-why" className="text-center text-[0.75rem] text-faint-foreground">
          {why}
        </p>
      ) : null}
      {!live ? (
        <Button type="button" variant="outline" onClick={onSaveDraft} disabled={isSubmitting} className={compact ? "" : "w-full"}>
          {isEditing ? "Save as draft" : "Save draft"}
        </Button>
      ) : null}
      {isEditing && !cancelled && !compact ? (
        <Button
          type="button"
          variant="ghost"
          onClick={onCancelEvent}
          disabled={isSubmitting}
          className="w-full text-muted-foreground hover:text-destructive"
        >
          Cancel event…
        </Button>
      ) : null}
    </div>
  )
}

export function PublishRail(props: PublishRailProps) {
  const { readiness, card, isEditing, status } = props
  const label =
    isEditing && status === "published"
      ? "Published"
      : isEditing && status === "cancelled"
        ? "Cancelled"
        : "Before it can publish"
  return (
    <aside
      aria-label="Publish"
      className="hidden @4xl/main:flex sticky top-5 flex-col gap-5 self-start"
    >
      <div>
        <p className="mb-2 text-[0.75rem] font-medium uppercase tracking-[0.06em] text-faint-foreground">
          On the Pulse
        </p>
        <CardPreview {...card} />
      </div>
      <div role="status" aria-live="polite">
        <p className="mb-2 text-[0.75rem] font-medium uppercase tracking-[0.06em] text-faint-foreground">
          {label}
        </p>
        <ReadinessList readiness={readiness} />
      </div>
      <Actions {...props} />
    </aside>
  )
}

/**
 * Below @4xl/main the rail is a bar that sticks to the bottom of the viewport
 * while the column scrolls. Sticky rather than fixed, so it never has to know
 * how wide the sidebar is or whether it is open.
 */
export function PublishBar(props: Omit<PublishRailProps, "card">) {
  const left = props.readiness.blockers.length
  return (
    <div className="@4xl/main:hidden sticky bottom-0 z-20 -mx-4 flex items-center gap-3 border-t border-border bg-background/90 px-4 py-2.5 text-[0.8125rem] backdrop-blur md:-mx-6">
      <span className="flex-1 truncate text-muted-foreground">
        {left === 0
          ? "Everything the app needs is here"
          : `${left} thing${left === 1 ? "" : "s"} left before it can publish`}
      </span>
      <Actions {...props} compact />
    </div>
  )
}
