"use client"

import { useRouter } from "next/navigation"
import { useEffect } from "react"

/**
 * Re-reads the server component around it every `ms` while the tab is in view.
 * `router.refresh()` keeps client state (a table's sort, search and page), so
 * only the figures move. Renders nothing.
 */
export function RefreshEvery({ ms }: { ms: number }) {
  const router = useRouter()
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh()
    }, ms)
    return () => clearInterval(timer)
  }, [ms, router])
  return null
}
