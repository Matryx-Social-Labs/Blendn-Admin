"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react"

export function FormSection({
  title,
  defaultOpen = true,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-lg border">
      <Button
        type="button"
        variant="ghost"
        className="flex w-full items-center justify-between px-4 py-3 text-left font-semibold hover:bg-muted/50 h-auto rounded-none"
        onClick={() => setOpen((v) => !v)}
      >
        {title}
        {open ? (
          <IconChevronUp className="size-4 text-muted-foreground" />
        ) : (
          <IconChevronDown className="size-4 text-muted-foreground" />
        )}
      </Button>
      {open && <div className="space-y-5 px-4 pb-5">{children}</div>}
    </div>
  )
}
