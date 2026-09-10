"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { type Icon } from "@tabler/icons-react"

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

/**
 * Compact single-line navigation.
 *
 * The previous version rendered each item as a two-line block with a bordered
 * icon tile and a wrapped description. At three items that was merely heavy; an
 * admin now has nine, and the nav would have run taller than the viewport while
 * repeating information the destination page already states.
 *
 * The description survives as the tooltip, which is where it was useful.
 */
export function NavMain({
  items,
  badges,
  label,
}: {
  /** The group heading. Omitted for the items that sit above the first one. */
  label?: string | null
  items: {
    title: string
    description: string
    url: string
    icon?: Icon
    badgeKey?: string
    isActive?: (pathname: string) => boolean
  }[]
  badges?: Record<string, number>
}) {
  const pathname = usePathname()

  return (
    <SidebarGroup className="px-2 py-1">
      {label ? (
        /*
          Same type treatment as the role label in the header — 0.6875rem,
          uppercase, wide tracking, faint. A second, louder style here would
          compete with the destinations themselves, which are the thing being
          scanned.
        */
        <div className="px-2.5 pb-1 pt-2 text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-faint-foreground">
          {label}
        </div>
      ) : null}
      <SidebarGroupContent>
        <SidebarMenu className="gap-0.5">
          {items.map((item) => {
            const isActive = item.isActive
              ? item.isActive(pathname)
              : pathname === item.url ||
                (item.url !== "/dashboard" && pathname.startsWith(item.url))
            const badge = item.badgeKey ? badges?.[item.badgeKey] : undefined

            return (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton
                  asChild
                  isActive={isActive}
                  tooltip={item.description}
                  className={cn(
                    "h-9 rounded-md px-2.5 transition-colors",
                    isActive
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  )}
                >
                  <Link href={item.url} className="flex w-full items-center gap-2.5">
                    {item.icon ? (
                      <item.icon
                        className={cn("size-[18px] shrink-0", isActive && "text-primary")}
                      />
                    ) : null}
                    <span className="flex-1 truncate text-[0.8125rem]">{item.title}</span>
                    {badge ? (
                      <span className="shrink-0 rounded-full bg-destructive px-1.5 py-0.5 text-[0.6875rem] font-bold leading-none text-destructive-foreground tabular-nums">
                        {badge > 99 ? "99+" : badge}
                      </span>
                    ) : null}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
