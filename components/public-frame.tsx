import Image from "next/image"
import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * The two frames every public page sits in (the platform kit's `public.jsx`).
 *
 * - `PublicFrame` — light, on the landing page's orange band: the pages a
 *   stranger reaches from the marketing site or the app (Apply, the claim
 *   pages). Light because they are the last step of a funnel that is light
 *   everywhere else; `.apply-light` re-declares `:root`'s values
 *   (`apply-theme.test.ts`), and this file is the one place that uses it.
 * - `AuthFrame` — the dashboard's own dark, one centred card under the
 *   gradient monogram: sign in, invite, forgotten and reset password. The
 *   card's 3px gradient stripe is the screen's one gradient element.
 *
 * Neither renders an `h1` of its own choosing: the page passes its title, so
 * each public page still has exactly one.
 */

const WIDTH = {
  wide: "apply-shell",
  medium: "max-w-[720px]",
  narrow: "max-w-lg",
} as const

export function PublicFrame({ children, width = "wide" }: { children: ReactNode; width?: keyof typeof WIDTH }) {
  return (
    <main className="apply-light apply-gradient flex min-h-screen items-start justify-center px-4 py-10 sm:px-6 md:items-center">
      <div className={cn("apply-card w-full overflow-hidden rounded-3xl border border-border bg-card", WIDTH[width])}>
        {children}
      </div>
    </main>
  )
}

/**
 * The landing page's lockup, not the dashboard's monogram-plus-wordmark: that
 * pairing appears nowhere on the marketing site and would read as a third
 * brand at the moment someone is deciding whether to trust us.
 */
export function PublicLockup({ className, priority }: { className?: string; priority?: boolean }) {
  return (
    <Image
      src="/brand/lockup-dark.webp"
      alt="Blend'n"
      width={852}
      height={240}
      priority={priority}
      className={cn("h-9 w-auto self-start", className)}
    />
  )
}

/** The landing page's brand chip ("Become a host", "Listed by Blend'n"). */
export function PublicChip({ children }: { children: ReactNode }) {
  return <span className="apply-chip w-fit">{children}</span>
}

export function AuthFrame({
  title,
  sub,
  children,
  after,
}: {
  title: string
  sub?: ReactNode
  /** The card's content. */
  children: ReactNode
  /** Under the card: a way back, a note. */
  after?: ReactNode
}) {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-6">
      {/* Oversized, barely-there monogram. Decorative: hidden from assistive tech, and not clickable. */}
      <Image
        src="/brand/monogram-gradient.png"
        alt=""
        aria-hidden
        width={560}
        height={560}
        className="pointer-events-none absolute -bottom-[18%] -right-[8%] w-[560px] max-w-none opacity-[0.04]"
      />
      <div className="relative flex w-full max-w-[400px] flex-col gap-7">
        <div className="flex flex-col items-center gap-3.5 text-center">
          <Image src="/brand/monogram-gradient.png" alt="Blend'n" width={64} height={64} priority />
          <div>
            <h1 className="text-[length:var(--text-h1)] font-bold">{title}</h1>
            {sub ? <p className="mt-1.5 text-sm text-muted-foreground">{sub}</p> : null}
          </div>
        </div>
        <div className="relative flex flex-col gap-4 overflow-hidden rounded-[var(--radius)] border border-border bg-card p-6">
          <div aria-hidden className="absolute inset-x-0 top-0 h-[3px] bg-[image:var(--gradient-brand)]" />
          {children}
        </div>
        {after}
      </div>
    </main>
  )
}
