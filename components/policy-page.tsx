import Link from "next/link"
import type { ReactNode } from "react"

import { PublicFrame, PublicLockup } from "@/components/public-frame"
import { COMPANY, POLICY_LINKS, type PolicyPath } from "@/lib/company"
import { cn } from "@/lib/utils"

/**
 * The public pages anyone can read without signing in: what is sold, who
 * sells it, and what happens to the money (Razorpay's website verification,
 * docs/RAZORPAY-VERIFICATION.md). Linked from the sign-in page's footer.
 *
 * Every page carries the same row of links, with its own marked, and ends on
 * the same seller block — the legal name, address, email and phone a reviewer
 * looks for, always in the same place.
 *
 * None of these paths is in middleware.ts's matcher, so none needs a session;
 * `__tests__/policy-pages-public.test.ts` holds that.
 */
export function PolicyPage({
  path,
  title,
  updated,
  lede,
  children,
}: {
  path: PolicyPath
  title: string
  /** "26 October 2026": when the text last changed. */
  updated: string
  lede?: ReactNode
  children: ReactNode
}) {
  return (
    <PublicFrame width="medium">
      <header className="flex flex-col gap-5 px-5 pt-7 sm:px-8">
        <Link href="/pricing" aria-label="Blend'n pricing">
          <PublicLockup />
        </Link>
        <nav aria-label="Policies">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 border-b border-border pb-3 text-[0.8125rem]">
            {POLICY_LINKS.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  aria-current={l.href === path ? "page" : undefined}
                  className={cn(
                    "text-muted-foreground hover:text-foreground",
                    l.href === path &&
                      "font-semibold text-foreground underline decoration-brand-orange decoration-2 underline-offset-[6px]"
                  )}
                >
                  {l.label}
                </Link>
              </li>
            ))}
            <li>
              <Link href="/login" className="text-muted-foreground hover:text-foreground">
                Sign in
              </Link>
            </li>
          </ul>
        </nav>
      </header>

      <main className="px-5 pb-2 pt-6 sm:px-8">
        <h1 className="text-[length:var(--text-page-title)] font-bold leading-tight">{title}</h1>
        <p className="mt-1 text-[0.75rem] text-faint-foreground">Last updated {updated}</p>
        {lede ? <p className="mt-3 text-muted-foreground">{lede}</p> : null}
        <div className="policy-prose mt-2">{children}</div>
      </main>

      <footer className="mt-7 grid gap-0.5 border-t border-border bg-secondary px-5 py-4 text-[0.75rem] text-muted-foreground sm:px-8">
        <strong className="text-[0.8125rem] text-foreground">{COMPANY.legalName}</strong>
        <span>{COMPANY.address}</span>
        <span>
          <a href={`mailto:${COMPANY.email}`} className="underline underline-offset-2">
            {COMPANY.email}
          </a>{" "}
          ·{" "}
          <a href={COMPANY.phoneHref} className="underline underline-offset-2">
            {COMPANY.phone}
          </a>
        </span>
      </footer>
    </PublicFrame>
  )
}
