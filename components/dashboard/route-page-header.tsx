"use client"

import { Suspense } from "react"
import { usePathname } from "next/navigation"

import { DateRangeControl } from "@/components/date-range-control"
import { PageHeader } from "@/components/dashboard/page-header"
import { ownsHeader, routeHeading, showsRange } from "@/lib/dashboard-route-content"

/**
 * The header every dashboard route gets from the layout, named from
 * `routeContent` by the same rule the breadcrumbs use — except the routes in
 * `OWNED_HEADERS`, whose page renders its own and gets nothing from here.
 *
 * The date range is the one page action the shell knows about: it rides here,
 * on the three routes whose numbers read it, rather than in the top bar where
 * it sat beside the search on every screen it could not affect.
 */
export function RoutePageHeader({ role }: { role: string }) {
  const pathname = usePathname()
  if (ownsHeader(pathname)) return null
  const { title, description } = routeHeading(pathname, role)

  return (
    <PageHeader
      title={title}
      description={description}
      actions={
        showsRange(pathname) ? (
          // useSearchParams needs a Suspense boundary or the whole route opts
          // out of static rendering and the build warns.
          <Suspense fallback={<div className="h-9 w-[250px]" />}>
            <DateRangeControl />
          </Suspense>
        ) : undefined
      }
    />
  )
}
