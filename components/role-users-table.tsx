"use client"

import * as React from "react"
import { format } from "date-fns"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { IconSearch, IconUserPlus } from "@tabler/icons-react"
import { CredentialModal } from "@/components/credential-modal"
import type { RoleUser } from "@/lib/admin-role-actions"
import type { user_role } from "@prisma/client"

interface RoleUsersTableProps {
  users: RoleUser[]
  role: user_role
  roleLabel: string
  detailBasePath: string // e.g. "/dashboard/organisers"
}

export function RoleUsersTable({ users, role, roleLabel, detailBasePath }: RoleUsersTableProps) {
  const [search, setSearch] = React.useState("")
  const [modalOpen, setModalOpen] = React.useState(false)

  const filtered = React.useMemo(() => {
    const q = search.toLowerCase()
    if (!q) return users
    return users.filter(
      (u) =>
        u.name?.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q)
    )
  }, [users, search])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex flex-1 items-center">
          <IconSearch className="pointer-events-none absolute left-4 size-4 text-white/34" />
          <Input
            placeholder={`Search ${roleLabel.toLowerCase()}s...`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-11 max-w-sm rounded-2xl border-white/10 bg-white/6 pl-11 text-white placeholder:text-white/34"
          />
        </div>
        <Button
          onClick={() => setModalOpen(true)}
          className="rounded-full bg-[#F05423] text-white hover:bg-[#d84a1d]"
        >
          <IconUserPlus className="size-4" />
          Generate Credentials
        </Button>
      </div>

      <div className="overflow-hidden rounded-[1.4rem] border border-white/10 bg-black/20">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-white/[0.03]">
            <TableRow className="border-white/10 hover:bg-transparent">
              <TableHead className="px-3 text-white/48">Name</TableHead>
              <TableHead className="px-3 text-white/48">Email</TableHead>
              <TableHead className="px-3 text-white/48">Events</TableHead>
              <TableHead className="px-3 text-white/48">Joined</TableHead>
              <TableHead className="w-24 px-3 text-white/48">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-white/54">
                  No {roleLabel.toLowerCase()}s found.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((user) => {
                const initials = user.name
                  ? user.name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2)
                  : user.email[0].toUpperCase()

                return (
                  <TableRow key={user.id} className="border-white/8 hover:bg-white/[0.03]">
                    <TableCell className="px-3 py-4">
                      <div className="flex items-center gap-3">
                        <Avatar className="h-8 w-8">
                          <AvatarImage src={user.image ?? ""} alt={user.name ?? user.email} />
                          <AvatarFallback className="bg-gradient-to-br from-[#F05423] to-[#865693] text-white">
                            {initials}
                          </AvatarFallback>
                        </Avatar>
                        <span className="font-medium text-white">{user.name ?? "Unnamed"}</span>
                      </div>
                    </TableCell>
                    <TableCell className="px-3 text-sm text-white/62">{user.email}</TableCell>
                    <TableCell className="px-3">
                      <span className="text-sm text-white">{user._count.organized_events}</span>
                    </TableCell>
                    <TableCell className="px-3 text-sm text-white/62">
                      {format(new Date(user.createdAt), "MMM d, yyyy")}
                    </TableCell>
                    <TableCell className="px-3">
                      <Button
                        asChild
                        variant="outline"
                        size="sm"
                        className="rounded-full border-white/12 bg-white/5 text-white hover:bg-white/10"
                      >
                        <Link href={`${detailBasePath}/${user.id}`}>View</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      <CredentialModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        role={role}
        roleLabel={roleLabel}
      />
    </div>
  )
}
