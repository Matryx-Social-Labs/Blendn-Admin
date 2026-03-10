import Image from "next/image"

import { cn } from "@/lib/utils"

type BrandLogoSize = "hero" | "sidebar" | "header"

interface BrandLogoProps {
  compact?: boolean
  size?: BrandLogoSize
  showTagline?: boolean
  className?: string
}

const sizeConfig: Record<
  BrandLogoSize,
  {
    imageWidth: number
    imageHeight: number
    containerPadding: string
    gap: string
  }
> = {
  hero: {
    imageWidth: 156,
    imageHeight: 44,
    containerPadding: "px-4 py-2",
    gap: "gap-3",
  },
  sidebar: {
    imageWidth: 112,
    imageHeight: 32,
    containerPadding: "px-3.5 py-2",
    gap: "gap-3",
  },
  header: {
    imageWidth: 88,
    imageHeight: 25,
    containerPadding: "px-3 py-1.5",
    gap: "gap-2.5",
  },
}

export function BrandLogo({
  compact = false,
  size,
  showTagline = false,
  className,
}: BrandLogoProps) {
  const resolvedSize = size ?? (compact ? "sidebar" : "hero")
  const config = sizeConfig[resolvedSize]

  return (
    <div className={cn("flex items-center", config.gap, className)}>
      <div
        className={cn(
          "brand-wordmark relative flex items-center rounded-full bg-white/92 shadow-[0_14px_40px_rgba(0,0,0,0.28)]",
          config.containerPadding
        )}
      >
        <Image
          src="/brand/blend-logo.png"
          alt="Blend'n"
          width={config.imageWidth}
          height={config.imageHeight}
          className="h-auto w-auto"
          priority
        />
      </div>
      {showTagline ? (
        <div className="min-w-0">
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.24em] text-white/65">
            Blend&apos;n Workspace
          </p>
          {resolvedSize === "hero" ? (
            <p className="text-sm text-white/72">
              Workspace for events, venues, and operations.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
