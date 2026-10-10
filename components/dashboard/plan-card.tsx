import { IconCheck } from "@tabler/icons-react"
import type { ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

/**
 * One plan, as the kit's Plan screen draws it (`screens-org.jsx` Plan): name,
 * price, what it includes. The paid card carries the plan-card stripe (R4),
 * the one gradient a screen may carry besides its own. Shared by an
 * organiser's plans and a venue's (step 17).
 */
export function PlanCard({
  name,
  tag,
  brand,
  current,
  items,
  children,
}: {
  name: string
  tag?: ReactNode
  brand?: boolean
  current?: boolean
  items: string[]
  children: ReactNode
}) {
  return (
    <section
      aria-label={`${name} plan`}
      className={cn(
        "relative flex min-w-0 flex-col gap-4 overflow-hidden rounded-xl border bg-card p-6",
        brand ? "border-primary/45" : "border-border"
      )}
    >
      {/* The plan card's stripe (R4): on the paid card only. */}
      {brand ? <div aria-hidden="true" className="absolute inset-x-0 top-0 h-[3px] bg-[image:var(--gradient-brand)]" /> : null}
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[1.25rem] font-bold">{name}</h2>
        {current ? <Badge variant="outline">Current plan</Badge> : tag}
      </div>
      {children}
      <ul className="flex flex-1 flex-col gap-2.5">
        {items.map((item) => (
          <li key={item} className="flex gap-2.5 text-[0.84375rem]">
            <IconCheck aria-hidden className={cn("mt-0.5 size-4 shrink-0", brand ? "text-primary" : "text-success")} />
            {item}
          </li>
        ))}
      </ul>
    </section>
  )
}
