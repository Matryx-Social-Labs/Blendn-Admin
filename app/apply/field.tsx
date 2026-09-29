import { cloneElement, isValidElement, useId } from "react"

import { Label } from "@/components/ui/label"

/**
 * One /apply field: its caption, its control, its hint.
 *
 * The caption is the control's name for a screen reader (SCRUM-183). The label
 * used to have no `for` and the control no id, so the name field was read out
 * as its placeholder ("Byg Brewski Brewing Company") and Address and Full name
 * had no name at all. The hint is tied to the control too, so it is read with it.
 */
export function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string
  required?: boolean
  hint?: string
  children?: React.ReactNode
}) {
  const id = useId()
  const hintId = `${id}-hint`
  const control = isValidElement(children)
    ? cloneElement(children as React.ReactElement<{ id?: string; "aria-describedby"?: string }>, {
        id,
        ...(hint ? { "aria-describedby": hintId } : {}),
      })
    : children

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
        {required ? <span className="text-muted-foreground"> *</span> : null}
      </Label>
      {control}
      {hint ? (
        <p id={hintId} className="text-xs leading-5 text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
