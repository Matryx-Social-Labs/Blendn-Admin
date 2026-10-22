import type { ReactNode } from "react"
import Link from "next/link"
import { IconArrowLeft } from "@tabler/icons-react"

/**
 * The page's name: its only `h1`, in the content area (R5).
 *
 * 26px title, one sentence under it, the page's actions on the right, and an
 * optional back link above. It used to live in the top bar at 20px, which
 * left the title and the actions it governs on opposite sides of a hairline.
 *
 * Rendered by the layout for most routes (`RoutePageHeader`), and by the page
 * itself, server-side and first, for the routes in `OWNED_HEADERS` — a record
 * named by its own title, with its own actions.
 *
 * Kept out of `components/dashboard/kit.tsx` because it holds an `h1`:
 * `dashboard-header-title.test.ts` reads every component a page imports for
 * one, and a page importing a Panel must not inherit this heading.
 */
export function PageHeader({
  title,
  description,
  actions,
  back,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  back?: { href: string; label: string }
  /** Under the description: a line of facts, a status, a link. */
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3.5">
      {back ? (
        <Link
          href={back.href}
          className="inline-flex w-fit items-center gap-1.5 text-[0.8125rem] text-muted-foreground transition-colors hover:text-foreground"
        >
          <IconArrowLeft aria-hidden className="size-3.5" />
          {back.label}
        </Link>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-4">
        {/* `basis-80`: when the title and the actions cannot share a row at
            20rem, the actions wrap below rather than squeezing the sentence
            into a column three words wide. */}
        <div className="flex min-w-0 flex-1 basis-80 flex-col gap-1.5">
          <h1 className="text-page-title font-bold leading-[1.15] text-balance break-words">{title}</h1>
          {description ? (
            <p className="max-w-[70ch] text-[0.875rem] text-muted-foreground text-pretty">
              {description}
            </p>
          ) : null}
          {children}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  )
}
