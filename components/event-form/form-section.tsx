"use client"

import { useId, useState } from "react"
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react"

/**
 * A step of the form: a number, a heading and a rule, in the kit's bordered
 * panel (R3, step 15). Five of them, not eight, and none inside another — a
 * sub-section (`level={3}`) inside "More" stays a heading and a rule. The only
 * thing that folds is "More", because that is the one section an organiser
 * does not need on the first pass.
 */
export function FormSection({
  step,
  title,
  hint,
  id,
  collapsible = false,
  defaultOpen = true,
  level = 2,
  children,
}: {
  /** "01" … "05". Absent on sub-sections inside More. */
  step?: string
  title: string
  /** The one line that earns its place — a rule, not a description. */
  hint?: string
  /** The anchor the rail's links scroll to. */
  id?: string
  collapsible?: boolean
  defaultOpen?: boolean
  level?: 2 | 3
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const headingId = useId()
  const Heading = level === 2 ? "h2" : "h3"

  const heading = (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      {step ? (
        <span
          className="text-[0.75rem] font-bold tracking-[0.06em] text-faint-foreground"
          aria-hidden
        >
          {step}
        </span>
      ) : null}
      <Heading
        id={headingId}
        className={level === 2 ? "text-panel-title font-bold" : "text-[0.9375rem] font-bold"}
      >
        {title}
      </Heading>
      {hint ? <span className="text-[0.8125rem] text-muted-foreground">{hint}</span> : null}
    </div>
  )

  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={
        level === 2
          ? // Clear of the 60px sticky top bar when a rail link scrolls here.
            "scroll-mt-[84px] rounded-panel border border-border bg-card px-5 pt-4 pb-5"
          : "pt-2 pb-4 scroll-mt-6"
      }
    >
      {collapsible ? (
        <button
          type="button"
          className="flex w-full items-center gap-2 text-left"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? (
            <IconChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <IconChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          {heading}
        </button>
      ) : (
        heading
      )}
      {open ? <div className="mt-4 space-y-5">{children}</div> : null}
    </section>
  )
}
