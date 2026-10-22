import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * `size` is the kit's (`"lg"` for sign-in and set-up forms), which is why the
 * native numeric `size` attribute is not accepted — nothing here used it.
 * `invalid` sets `aria-invalid`, which is what the error styling keys off, so
 * the red border and what a screen reader hears cannot disagree.
 */
function Input({
  className,
  type,
  size = "default",
  icon,
  invalid,
  wrapperClassName,
  ...props
}: Omit<React.ComponentProps<"input">, "size"> & {
  size?: "default" | "lg"
  /** Drawn inside the field on the left, e.g. a search or map-pin glyph. */
  icon?: React.ReactNode
  invalid?: boolean
  /**
   * With `icon`, the field sits in a wrapper, so `className` reaches the input
   * and this reaches the box around it — a width or a flex rule belongs here.
   */
  wrapperClassName?: string
}) {
  const input = (
    <input
      {...props}
      type={type}
      data-slot="input"
      aria-invalid={invalid || props["aria-invalid"] || undefined}
      className={cn(
        "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        size === "lg" && "h-11 px-3.5",
        icon && (size === "lg" ? "pl-10" : "pl-9"),
        className
      )}
    />
  )

  if (!icon) return input
  return (
    <div className={cn("relative w-full", wrapperClassName)}>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-faint-foreground [&_svg]:size-4"
      >
        {icon}
      </span>
      {input}
    </div>
  )
}

export { Input }
