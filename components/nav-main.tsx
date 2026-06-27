"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { type Icon } from "@tabler/icons-react"

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

export function NavMain({
  items,
}: {
  items: {
    title: string
    description: string
    url: string
    icon?: Icon
    isActive?: (pathname: string) => boolean
  }[]
}) {
  const pathname = usePathname()

  return (
    <SidebarGroup>
      <SidebarGroupLabel className="px-3 text-[0.7rem] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
        Workspace
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu className="gap-2">
          {items.map((item) => {
            const isActive = item.isActive
              ? item.isActive(pathname)
              : pathname === item.url ||
                (item.url !== "/dashboard" && pathname.startsWith(item.url))

            return (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton
                  asChild
                  isActive={isActive}
                  size="lg"
                  tooltip={item.title}
                  className={cn(
                    "h-auto rounded-xl border border-transparent px-3 py-3 transition-all",
                    isActive
                      ? "border-border bg-accent text-accent-foreground shadow-sm"
                      : "bg-transparent text-muted-foreground hover:border-border hover:bg-accent/50 hover:text-accent-foreground"
                  )}
                >
                  <Link href={item.url} className="flex w-full items-start gap-3">
                    {item.icon ? (
                      <div
                        className={cn(
                          "mt-0.5 rounded-lg border border-border p-2",
                          isActive ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                        )}
                      >
                        <item.icon className="size-4" />
                      </div>
                    ) : null}
                    <div className="min-w-0 space-y-1">
                      <p className="truncate text-sm font-semibold">{item.title}</p>
                      <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
                        {item.description}
                      </p>
                    </div>
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
