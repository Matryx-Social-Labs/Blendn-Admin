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
      <SidebarGroupLabel className="px-3 text-[0.7rem] font-semibold uppercase tracking-[0.24em] text-white/40">
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
                    "h-auto rounded-2xl border border-transparent px-3 py-3 transition-all",
                    isActive
                      ? "border-white/12 bg-white/10 text-white shadow-[0_18px_40px_rgba(0,0,0,0.22)]"
                      : "bg-transparent text-white/72 hover:border-white/10 hover:bg-white/6 hover:text-white"
                  )}
                >
                  <Link href={item.url} className="flex w-full items-start gap-3">
                    {item.icon ? (
                      <div
                        className={cn(
                          "mt-0.5 rounded-xl border border-white/8 p-2",
                          isActive ? "bg-[#F05423] text-white" : "bg-white/6 text-white/72"
                        )}
                      >
                        <item.icon className="size-4" />
                      </div>
                    ) : null}
                    <div className="min-w-0 space-y-1">
                      <p className="truncate text-sm font-semibold">{item.title}</p>
                      <p className="line-clamp-2 text-xs leading-5 text-white/48">
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
