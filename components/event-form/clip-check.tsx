"use client"

import { useId } from "react"
import { RadioGroup as RadioGroupPrimitive } from "radix-ui"
import { IconCheck, IconLoader2 } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import { RadioGroup } from "@/components/ui/radio-group"
import { clipFacts, stillClock, type ClipCheckState } from "@/components/event-form/check-clip"
import type { CheckedClip } from "@/lib/media-clip"

/**
 * One line under a clip's URL: checking, checked, or not checked (board
 * t30-clip-check, Check A). A refusal is the URL field's own message instead,
 * because it stops the save.
 */
export function ClipCheckLine({
  state,
  stored,
  refused,
  onCheck,
}: {
  state: ClipCheckState | undefined
  /** The row's own facts once it has been checked; null = never checked. */
  stored: { width: number; height: number; durationMs: number } | null
  refused: boolean
  onCheck: () => void
}) {
  if (refused && state?.kind !== "checking") return null
  if (state?.kind === "checking") {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <IconLoader2 aria-hidden className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
        Checking the clip… this can take a minute. You can keep editing.
      </p>
    )
  }
  const failed = state?.kind === "failed" ? state.message : null
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
      <p role="status" className="flex min-w-0 flex-1 basis-64 items-start gap-2">
        {!failed && stored ? (
          <>
            <IconCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
            <span>
              <strong className="font-semibold text-foreground tabular-nums">
                {clipFacts(stored.width, stored.height, stored.durationMs)}.
              </strong>{" "}
              Ready for the app, with a small copy for mobile data.
            </span>
          </>
        ) : (
          (failed ?? "This clip hasn’t been checked yet.")
        )}
      </p>
      <Button type="button" variant={!failed && stored ? "ghost" : "outline"} size="sm" onClick={onCheck}>
        {failed || stored ? "Check again" : "Check clip"}
      </Button>
    </div>
  )
}

/** Six stills from the clip, under its poster field: one click makes one the poster (Frame A). */
export function ClipStills({
  stills,
  value,
  onPick,
}: {
  stills: CheckedClip["stills"]
  value: string
  onPick: (url: string) => void
}) {
  const labelId = useId()
  const noteId = useId()
  return (
    <div className="space-y-2">
      <p id={labelId} className="text-sm font-medium">
        Or pick a still from the clip
      </p>
      <RadioGroup
        value={value}
        onValueChange={onPick}
        aria-labelledby={labelId}
        aria-describedby={noteId}
        className="grid-cols-3 gap-2 @lg:grid-cols-6"
      >
        {stills.map((still, i) => {
          const label = i === 0 ? "First frame" : stillClock(still.at)
          return (
            <RadioGroupPrimitive.Item
              key={still.url}
              value={still.url}
              aria-label={label}
              className="group flex cursor-pointer flex-col gap-1 rounded-lg text-left outline-none"
            >
              <span className="relative block aspect-video overflow-hidden rounded-lg border-2 border-transparent bg-muted group-data-[state=checked]:border-primary group-focus-visible:ring-[3px] group-focus-visible:ring-ring/50">
                {/* eslint-disable-next-line @next/next/no-img-element -- a still from storage, at thumbnail size */}
                <img src={still.url} alt="" className="size-full object-cover" />
                <RadioGroupPrimitive.Indicator className="absolute top-1 right-1 grid size-4 place-items-center rounded-full bg-primary text-primary-foreground">
                  <IconCheck aria-hidden className="size-3" />
                </RadioGroupPrimitive.Indicator>
              </span>
              <span aria-hidden className="text-xs text-muted-foreground tabular-nums">
                {label}
              </span>
            </RadioGroupPrimitive.Item>
          )
        })}
      </RadioGroup>
      <p id={noteId} className="text-xs text-muted-foreground">
        The first frame starts cleanly. Any other still shows first, then jumps to the clip&apos;s opening when it
        plays.
      </p>
    </div>
  )
}
