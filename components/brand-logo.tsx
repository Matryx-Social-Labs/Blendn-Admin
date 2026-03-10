import Image from "next/image"

import { cn } from "@/lib/utils"

interface BrandLogoProps {
  compact?: boolean
  showTagline?: boolean
  className?: string
}

export function BrandLogo({
  compact = false,
  showTagline = false,
  className,
}: BrandLogoProps) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="brand-wordmark relative flex items-center rounded-full bg-white/92 px-4 py-2 shadow-[0_14px_40px_rgba(0,0,0,0.28)]">
        <Image
          src="/brand/blend-logo.png"
          alt="Blend'n"
          width={compact ? 112 : 156}
          height={compact ? 32 : 44}
          className="h-auto w-auto"
          priority
        />
      </div>
      {showTagline ? (
        <div className="min-w-0">
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.24em] text-white/65">
            Blend&apos;n Admin
          </p>
          {!compact ? (
            <p className="text-sm text-white/72">
              Investor-ready insights for live social discovery.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
