import { cloneElement, isValidElement, useId, useState } from "react"

import { Label } from "@/components/ui/label"

type Control = HTMLInputElement | HTMLTextAreaElement

/**
 * One /apply field: its caption, its control, its hint, and its error.
 *
 * The caption is the control's name for a screen reader (SCRUM-183). The label
 * used to have no `for` and the control no id, so the name field was read out
 * as its placeholder ("Byg Brewski Brewing Company") and Address and Full name
 * had no name at all. The hint is tied to the control too, so it is read with it.
 *
 * The error is the browser's own validation message, shown when the control
 * fails a submit and tied to it with `aria-invalid` and `aria-describedby`
 * (SCRUM-470). The browser's bubble said it once and vanished; a screen reader
 * heard "required" with nothing to say what was wrong.
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
  const errorId = `${id}-error`
  const [error, setError] = useState("")
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ")

  const control = isValidElement(children)
    ? cloneElement(children as React.ReactElement<React.InputHTMLAttributes<Control>>, {
        id,
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
        ...(error ? { "aria-invalid": true } : {}),
        onInvalid: (e: React.FormEvent<Control>) => setError(e.currentTarget.validationMessage),
        onInput: (e: React.FormEvent<Control>) => {
          if (e.currentTarget.validity.valid) setError("")
        },
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
      {error ? (
        <p id={errorId} className="text-xs leading-5 text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
