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
        <div className="flex items-center gap-2 flex-1">
          <IconSearch className="text-muted-foreground size-4" />
          <Input
            placeholder={`Search ${roleLabel.toLowerCase()}s...`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-sm"
          />
        </div>
        <Button onClick={() => setModalOpen(true)}>
          <IconUserPlus className="mr-2 size-4" />
          Generate Credentials
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader className="bg-muted sticky top-0 z-10">
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Events</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="w-24">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  No {roleLabel.toLowerCase()}s found.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((user) => {
                const initials = user.name
                  ? user.name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2)
                  : user.email[0].toUpperCase()

                return (
                  <TableRow key={user.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar className="h-8 w-8">
                          <AvatarImage src={user.image ?? ""} alt={user.name ?? user.email} />
                          <AvatarFallback>{initials}</AvatarFallback>
                        </Avatar>
                        <span className="font-medium">{user.name ?? "Unnamed"}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{user.email}</TableCell>
                    <TableCell>
                      <span className="text-sm">{user._count.organized_events}</span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {format(new Date(user.createdAt), "MMM d, yyyy")}
                    </TableCell>
                    <TableCell>
                      <Button asChild variant="outline" size="sm">
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
