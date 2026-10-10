"use client"

import { Suspense } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { IconMapPinPlus } from "@tabler/icons-react"

import { DateRangeControl } from "@/components/date-range-control"
import { PageHeader } from "@/components/dashboard/page-header"
import { Button } from "@/components/ui/button"
import { ownsHeader, routeHeading, showsRange } from "@/lib/dashboard-route-content"

/**
 * The header every dashboard route gets from the layout, named from
 * `routeContent` by the same rule the breadcrumbs use — except the routes in
 * `OWNED_HEADERS`, whose page renders its own and gets nothing from here.
 *
 * The date range is the one page action the shell knows about: it rides here,
 * on the three routes whose numbers read it, rather than in the top bar where
 * it sat beside the search on every screen it could not affect.
 *
 * The one other: an admin's events list offers "Curate from a listing" (the
 * kit's AdminEvents), because the curation screen is not in the nav and
 * finding an event is when you notice one is missing. Create stays in the top
 * bar, where every role that may create already has it.
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
        showsRange(pathname, role) ? (
          // useSearchParams needs a Suspense boundary or the whole route opts
          // out of static rendering and the build warns.
          <Suspense fallback={<div className="h-9 w-[250px]" />}>
            <DateRangeControl />
          </Suspense>
        ) : pathname === "/dashboard/events" && role === "app_admin" ? (
          <Button asChild variant="outline" className="rounded-full">
            <Link href="/dashboard/events/curate">
              <IconMapPinPlus aria-hidden className="size-4" />
              Curate from a listing
            </Link>
          </Button>
        ) : undefined
      }
    />
  )
}
