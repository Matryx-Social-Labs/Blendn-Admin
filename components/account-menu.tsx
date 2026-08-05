"use client"

import { useRouter } from "next/navigation"
import { IconBuilding, IconChevronDown, IconLogout, IconSettings } from "@tabler/icons-react"
import { signOut } from "next-auth/react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/**
 * The account control, sized for a header row.
 *
 * It replaces `NavUser`, which was built from `SidebarMenu` primitives for the
 * 288px sidebar footer — `size="lg"`, `h-auto py-3`, and a three-line
 * name/email/role stack. Dropped into a horizontal header it was an oversized
 * block that fought everything beside it.
 *
 * So: a 40px trigger showing only the avatar and a chevron. Name and email move
 * *inside* the menu, where there is room for them and where they are only
 * needed when you are about to act on the account.
 *
 * The role is deliberately absent. It appears once, in the sidebar. It used to
 * render in the sidebar, in a header pill, on this trigger, and again in this
 * menu — four times on one screen.
 */
export function AccountMenu({
  name,
  email,
  image,
  showOrganisation,
}: {
  name: string
  email: string
  image?: string | null
  /** Hosts get a link to their org; platform admins have a different screen. */
  showOrganisation: boolean
}) {
  const router = useRouter()
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "B"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Account: ${name}`}
          className="inline-flex h-10 shrink-0 cursor-pointer items-center gap-1.5 rounded-[10px] border border-transparent py-0 pl-1 pr-1.5 transition-colors hover:border-border hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Avatar className="size-[30px]">
            <AvatarImage src={image ?? undefined} alt="" />
            {/* The brand gradient is reserved for the one hero metric per
                screen, but an avatar fallback is an identity mark rather than a
                competing priority. */}
            <AvatarFallback className="bg-[image:var(--gradient-brand)] text-[0.75rem] font-bold text-brand-ink">
              {initials}
            </AvatarFallback>
          </Avatar>
          <IconChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>

      {/* Down and aligned to the right edge. The old menu used side="right",
          which flew off the screen from a trigger already pinned there. */}
      <DropdownMenuContent side="bottom" align="end" sideOffset={6} className="min-w-56">
        <div className="flex flex-col gap-0.5 border-b border-border px-2.5 pb-2.5 pt-2">
          <span className="truncate text-[0.84375rem] font-bold">{name}</span>
          {email ? (
            <span className="truncate text-[0.75rem] text-muted-foreground">{email}</span>
          ) : null}
        </div>
        <DropdownMenuItem onClick={() => router.push("/dashboard/settings")}>
          <IconSettings className="size-4 text-muted-foreground" />
          Account settings
        </DropdownMenuItem>
        {showOrganisation ? (
          <DropdownMenuItem onClick={() => router.push("/dashboard/organisation")}>
            <IconBuilding className="size-4 text-muted-foreground" />
            Your organisation
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="text-destructive focus:text-destructive"
        >
          <IconLogout className="size-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
