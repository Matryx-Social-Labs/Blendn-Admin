import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        destructive:
          "bg-destructive text-white shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  /*
   * `type="button"` unless the caller says otherwise.
   *
   * HTML defaults a `<button>` inside a `<form>` to `type="submit"`, so any
   * `<Button onClick={…}>` in a form submitted it. That is not a theoretical
   * footgun: the geofence editor's Map/Satellite toggle did exactly this, and
   * clicking it threw the organiser to the top of the event form with five
   * fields flagged red — a bug reported from a real session and reproduced on
   * staging (scroll position 3018 → 0, `title`, `description`,
   * `full_description`, `start_time`, `end_time` all `aria-invalid`).
   *
   * `components/venue-create-form.tsx` already carried six hand-added
   * `type="button"` attributes, which is the same bug being patched one call
   * site at a time.
   *
   * Safe to change: every `<form>` in this codebase gives its submit button an
   * explicit `type="submit"` — seven forms, seven explicit, none relying on the
   * implicit default. Swept before changing this, because the failure mode of
   * getting it wrong is a form that silently cannot be submitted.
   *
   * `asChild` renders a Slot, which forwards to whatever element the caller
   * passed — often an anchor, where a `type` attribute is meaningless. So the
   * default is only applied when this actually renders a button.
   */
  const typeProps = Comp === "button" ? { type: props.type ?? ("button" as const) } : {}

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
      {...typeProps}
    />
  )
}

export { Button, buttonVariants }
