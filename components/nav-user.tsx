"use client"

import { useRouter } from "next/navigation"
import {
  IconDotsVertical,
  IconLayoutDashboard,
  IconLogout,
  IconUserCircle,
} from "@tabler/icons-react"
import { signOut } from "next-auth/react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"

function getInitials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("")
}

export function NavUser({
  user,
}: {
  user: {
    name: string
    email: string
    avatar: string
    role?: string
  }
}) {
  const { isMobile } = useSidebar()
  const router = useRouter()
  const roleLabel = user.role?.replace(/_/g, " ")

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="h-auto rounded-[1.1rem] border border-white/10 bg-white/[0.04] px-3 py-3 text-white hover:bg-white/8 data-[state=open]:bg-white/10"
            >
              <Avatar className="h-10 w-10 rounded-2xl">
                <AvatarImage src={user.avatar} alt={user.name} />
                <AvatarFallback className="rounded-2xl bg-gradient-to-br from-[#F05423] to-[#865693] text-sm font-semibold text-white">
                  {getInitials(user.name || "Blend'n")}
                </AvatarFallback>
              </Avatar>
              <div className="grid min-w-0 flex-1 text-left leading-tight">
                <span className="truncate text-sm font-semibold text-white">{user.name}</span>
                <span className="truncate text-xs text-white/56">{user.email}</span>
                {roleLabel ? (
                  <span className="truncate text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-[#ffb391]">
                    {roleLabel}
                  </span>
                ) : null}
              </div>
              <IconDotsVertical className="ml-auto size-4 text-white/46" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-64 rounded-2xl border-white/10 bg-[#0d0d10]/96 text-white"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={6}
          >
            <DropdownMenuLabel className="p-0">
              <div className="flex items-center gap-3 px-3 py-3">
                <Avatar className="h-10 w-10 rounded-2xl">
                  <AvatarImage src={user.avatar} alt={user.name} />
                  <AvatarFallback className="rounded-2xl bg-gradient-to-br from-[#F05423] to-[#865693] text-sm font-semibold text-white">
                    {getInitials(user.name || "Blend'n")}
                  </AvatarFallback>
                </Avatar>
                <div className="grid min-w-0 flex-1 leading-tight">
                  <span className="truncate text-sm font-semibold text-white">{user.name}</span>
                  <span className="truncate text-xs text-white/56">{user.email}</span>
                  {roleLabel ? (
                    <span className="truncate text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-[#ffb391]">
                      {roleLabel}
                    </span>
                  ) : null}
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator className="bg-white/10" />
            <DropdownMenuItem
              onClick={() => router.push("/dashboard")}
              className="rounded-xl text-white/82 focus:bg-white/8 focus:text-white"
            >
              <IconLayoutDashboard className="size-4" />
              Dashboard overview
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => router.push("/")}
              className="rounded-xl text-white/82 focus:bg-white/8 focus:text-white"
            >
              <IconUserCircle className="size-4" />
              Public landing
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-white/10" />
            <DropdownMenuItem
              onClick={() => signOut({ callbackUrl: "/login" })}
              className="rounded-xl text-white/82 focus:bg-white/8 focus:text-white"
            >
              <IconLogout className="size-4" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
