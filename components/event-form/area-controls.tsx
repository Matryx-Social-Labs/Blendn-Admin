"use client"

import { useId, type ComponentProps, type ReactNode } from "react"

import type { AreaTools } from "@/components/geofence-editor"
import { Slider } from "@/components/ui/slider"
import type { Geofence } from "@/lib/geofence"
import { cn } from "@/lib/utils"

/** The slider's end: the owner's 15–25 m then sits in its first quarter, not its first tenth. */
const SLIDER_MAX_M = 100

/**
 * Under the event's map, the two things an organiser may change about the
 * area (SCRUM-353): whose buffer, and — only if the shape is wrong — the shape.
 *
 * The area arrives already set: a listed venue's outline, OpenStreetMap's, the
 * building's, or a circle when there is none. So the buffer is a choice
 * between the base (the venue's, else the default) and Custom, and reshaping
 * sits behind "Adjust area" — the map shows no handles until it is open.
 * There is no radius to set for an outline: the ring grows and shrinks with it.
 */
export function AreaControls({
  fence,
  base,
  baseIsVenue,
  custom,
  onBase,
  onCustom,
  onBuffer,
  adjusting,
  onAdjusting,
  adjustLabel,
  tools,
}: {
  fence: Geofence | null
  base: number
  baseIsVenue: boolean
  custom: boolean
  onBase: () => void
  onCustom: () => void
  onBuffer: (metres: number) => void
  adjusting: boolean
  onAdjusting: (open: boolean) => void
  adjustLabel: string
  tools: AreaTools
}) {
  const id = useId()
  // Never below the venue's own buffer, however far down it was dragged.
  const max = Math.max(SLIDER_MAX_M, base, fence?.buffer ?? 0)
  const shape = fence?.type === "circle" ? "circle" : "outline"

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        {fence ? (
          <>
            <span id={`${id}-buffer`} className="text-[0.8125rem] font-semibold">
              Buffer
            </span>
            <div
              role="group"
              aria-labelledby={`${id}-buffer`}
              className="flex overflow-hidden rounded-lg border border-border-strong p-0.5"
            >
              <Choice pressed={!custom} onClick={onBase}>
                {baseIsVenue ? "Venue's" : "Default"} · {base} m
              </Choice>
              <Choice pressed={custom} onClick={onCustom}>
                Custom
              </Choice>
            </div>
          </>
        ) : null}
        <span className="flex-1" />
        <LinkButton aria-expanded={adjusting} aria-controls={`${id}-adjust`} onClick={() => onAdjusting(!adjusting)}>
          {adjustLabel}
        </LinkButton>
      </div>

      {fence && custom ? (
        <div className="flex flex-col gap-1.5 pt-1">
          <Slider
            min={0}
            max={max}
            step={5}
            value={[fence.buffer]}
            onValueChange={([v]) => onBuffer(v)}
            aria-label="Buffer, metres beyond the area"
          />
          <div className="flex justify-between text-[0.6875rem] text-muted-foreground">
            <span>0 m</span>
            <span>
              {fence.buffer} m beyond the {shape}
            </span>
            <span>{max} m</span>
          </div>
        </div>
      ) : null}

      <div
        id={`${id}-adjust`}
        hidden={!adjusting}
        className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-dashed border-border-strong pt-2.5"
      >
        {fence?.type === "polygon" ? <LinkButton onClick={tools.circle}>Use a circle instead</LinkButton> : null}
        <LinkButton onClick={tools.draw}>Draw it yourself</LinkButton>
        <LinkButton onClick={tools.findBuilding} disabled={tools.finding}>
          {tools.finding ? "Looking…" : "Find the building again"}
        </LinkButton>
        <p className="w-full text-[0.75rem] text-muted-foreground">
          {fence?.type === "circle"
            ? "Drag the centre to move it and the white handle to size it — the place as it is, not bigger to be safe."
            : "Drag a corner to reshape it; right-click one to remove it. The ring follows the outline — there is no radius to set."}
        </p>
      </div>
    </div>
  )
}

function Choice({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "min-h-7 rounded-md px-2.5 py-1 text-[0.75rem]",
        pressed ? "bg-surface-raised font-semibold" : "text-muted-foreground"
      )}
    >
      {children}
    </button>
  )
}

function LinkButton(props: ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className="text-[0.78125rem] underline underline-offset-[3px] disabled:text-muted-foreground disabled:no-underline"
    />
  )
}
