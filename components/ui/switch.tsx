"use client"

import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

/**
 * `label` wraps the switch in a `<label>`, so the words are its accessible name
 * and clicking them flips it — the kit's settings-row shape. Without a label it
 * is the bare control, and the caller names it.
 */
function Switch({
  className,
  label,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & { label?: React.ReactNode }) {
  const control = (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer data-[state=checked]:bg-primary data-[state=unchecked]:bg-input focus-visible:border-ring focus-visible:ring-ring/50 dark:data-[state=unchecked]:bg-input/80 inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "bg-background dark:data-[state=unchecked]:bg-foreground dark:data-[state=checked]:bg-primary-foreground pointer-events-none block size-4 rounded-full ring-0 transition-transform data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0"
        )}
      />
    </SwitchPrimitive.Root>
  )

  if (label === undefined) return control
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 text-[0.875rem] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
      <span>{label}</span>
      {control}
    </label>
  )
}

export { Switch }
