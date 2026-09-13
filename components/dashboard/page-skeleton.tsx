import { Skeleton } from "@/components/ui/skeleton"

/**
 * Shared loading shapes for dashboard routes.
 *
 * These pages are server components doing real aggregation, so without a
 * loading.tsx the route just shows nothing until the query returns. The shapes
 * mirror the real layout: tiles, divided rows, sections with a rule — and no
 * gutter, because `app/dashboard/layout.tsx` owns it. The old skeletons drew
 * cards, a boxed page header and a second `px-4 lg:px-6`, so every route
 * loaded into chrome the page then replaced.
 */

/** The one line a page adds under the site header — a title or a sentence. */
export function PageHeaderSkeleton() {
  return <Skeleton className="h-5 w-64" />
}

export function StatCardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="flex flex-wrap gap-1">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex min-w-44 flex-col gap-2 py-3.5 pr-6">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-16" />
          <Skeleton className="h-3 w-28" />
        </div>
      ))}
    </div>
  )
}

export function TableSkeleton({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="border-t border-border">
      <div className="flex gap-4 border-b border-border py-3">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 border-b border-border py-4 last:border-b-0">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  )
}

export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="flex flex-col divide-y divide-border border-t border-border">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2 py-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  )
}
