"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  ColumnDef,
  ColumnFiltersState,
  SortingState,
  VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
  IconDotsVertical,
  IconEdit,
  IconLayoutColumns,
  IconMapPin,
  IconPhone,
  IconSearch,
} from "@tabler/icons-react"
import { format } from "date-fns"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { toast } from "sonner"

import { rowCountLabel } from "@/lib/row-count-label"
import { UserWithProfile, updateUser, updateUserRole } from "./actions"
import type { user_role } from "@prisma/client"

interface UsersTableProps {
  data: UserWithProfile[]
  total: number
  currentUserRole: string
  onRefresh?: () => void
}

const ROLE_LABELS: Record<string, string> = {
  app_admin: "App Admin",
  organizer: "Organizer",
  venue_owner: "Venue Owner",
  attendee: "Attendee",
}

/**
 * Brand chart hues rather than raw hexes, so these follow the theme instead of
 * staying violet/blue/green while the rest of the app is orange and purple.
 */
const ROLE_COLORS: Record<string, React.CSSProperties> = {
  app_admin: { backgroundColor: "var(--chart-3)", color: "var(--background)" },
  organizer: { backgroundColor: "var(--chart-1)", color: "var(--background)" },
  venue_owner: { backgroundColor: "var(--chart-2)", color: "var(--background)" },
  attendee: { backgroundColor: "var(--muted)", color: "var(--muted-foreground)" },
}

// Actions cell component - extracted to comply with React hooks rules
function ActionsCell({
  row,
  table,
}: {
  row: { original: UserWithProfile }
  table: {
    options: {
      meta?: { onRefresh?: () => void; currentUserRole?: string }
    }
  }
}) {
  const user = row.original
  const currentUserRole = table.options.meta?.currentUserRole
  const [isEditOpen, setIsEditOpen] = React.useState(false)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="data-[state=open]:bg-muted text-muted-foreground flex size-8"
            size="icon"
          >
            <IconDotsVertical />
            <span className="sr-only">Open menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onClick={() => setIsEditOpen(true)}>
            <IconEdit className="mr-2 size-4" />
            Edit
          </DropdownMenuItem>
          {/*
            No Delete. Suspension is the reversible control and it lives on the
            moderation screens; a hard delete here cascaded other users' events,
            check-ins and chat history. See the note in ./actions.ts.
          */}
        </DropdownMenuContent>
      </DropdownMenu>

      <EditUserDialog
        user={user}
        open={isEditOpen}
        onOpenChange={setIsEditOpen}
        onSuccess={() => table.options.meta?.onRefresh?.()}
        currentUserRole={currentUserRole}
      />

    </>
  )
}

const columns: ColumnDef<UserWithProfile>[] = [
  {
    id: "select",
    header: ({ table }) => (
      <div className="flex items-center justify-center">
        <Checkbox
          checked={
            table.getIsAllPageRowsSelected() ||
            (table.getIsSomePageRowsSelected() && "indeterminate")
          }
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
          aria-label="Select all"
        />
      </div>
    ),
    cell: ({ row }) => (
      <div className="flex items-center justify-center">
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
          aria-label="Select row"
        />
      </div>
    ),
    enableSorting: false,
    enableHiding: false,
  },
  {
    accessorKey: "user",
    header: "User",
    cell: ({ row }) => {
      const user = row.original
      const initials = user.name
        ? user.name
            .split(" ")
            .map((n) => n[0])
            .join("")
            .toUpperCase()
        : user.email[0].toUpperCase()

      return (
        <div className="flex items-center gap-3">
          <Avatar className="h-9 w-9">
            <AvatarImage src={user.image || ""} alt={user.name || user.email} />
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div className="flex flex-col">
            <span className="font-medium">{user.name || "Unnamed User"}</span>
            <span className="text-muted-foreground text-xs">{user.email}</span>
          </div>
        </div>
      )
    },
    enableHiding: false,
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => {
      const user = row.original
      const isVerified = !!user.emailVerified
      const isOnboarded = user.profile?.onboarded

      return (
        <div className="flex flex-wrap gap-1">
          <Badge variant={isVerified ? "default" : "secondary"} className="text-xs">
            {isVerified ? "Verified" : "Unverified"}
          </Badge>
          {isOnboarded && (
            <Badge variant="outline" className="text-xs">
              Onboarded
            </Badge>
          )}
        </div>
      )
    },
  },
  {
    accessorKey: "role",
    header: "Role",
    cell: ({ row }) => {
      const role = row.original.role as string
      const style = ROLE_COLORS[role] ?? ROLE_COLORS.attendee
      const label = ROLE_LABELS[role] ?? role
      return (
        <span
          className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
          style={style}
        >
          {label}
        </span>
      )
    },
  },
  {
    accessorKey: "profile",
    header: "Profile",
    cell: ({ row }) => {
      const profile = row.original.profile
      if (!profile) return <span className="text-muted-foreground">-</span>

      return (
        <div className="flex flex-col gap-0.5 text-sm">
          {profile.phone && (
            <span className="flex items-center gap-1 text-xs">
              <IconPhone className="size-3" />
              {profile.phone}
            </span>
          )}
          {profile.location && (
            <span className="flex items-center gap-1 text-xs">
              <IconMapPin className="size-3" />
              {profile.location}
            </span>
          )}
          {profile.age && <span className="text-xs">{profile.age} years old</span>}
        </div>
      )
    },
  },
  {
    accessorKey: "interests",
    header: "Interests",
    cell: ({ row }) => {
      const interests = row.original.interests || []
      if (interests.length === 0) return <span className="text-muted-foreground">-</span>

      return (
        <div className="flex flex-wrap gap-1 max-w-[150px]">
          {interests.slice(0, 2).map((interest) => (
            <Badge key={interest} variant="secondary" className="text-xs">
              {interest}
            </Badge>
          ))}
          {interests.length > 2 && (
            <Badge variant="secondary" className="text-xs">
              +{interests.length - 2}
            </Badge>
          )}
        </div>
      )
    },
  },
  {
    accessorKey: "activity",
    header: "Activity",
    cell: ({ row }) => {
      const counts = row.original._count
      /*
       * One line, and nothing at all when there is nothing.
       *
       * This rendered three stacked lines per row unconditionally, so ten rows
       * of accounts that have done nothing yet — most of them, on a product
       * with 121 users — were thirty lines reading "0 events organized / 0
       * check-ins / 0 favorites". Thirty lines of zero is not information; it
       * is the column asserting itself over the two beside it that decide
       * whether an account is a problem.
       *
       * `check-ins` stays attendance-DAYS and stays labelled that way. It is
       * the one allowlisted row count in `count-people-boundary.test.ts`,
       * because "12 check-ins" is exactly what the number is.
       */
      const parts = [
        counts.organized_events > 0 ? `${counts.organized_events} organised` : null,
        counts.event_check_ins > 0 ? `${counts.event_check_ins} check-ins` : null,
        counts.event_favorites > 0 ? `${counts.event_favorites} saved` : null,
      ].filter(Boolean)

      return parts.length === 0 ? (
        <span className="text-xs text-faint-foreground">—</span>
      ) : (
        <span className="text-xs">{parts.join(" · ")}</span>
      )
    },
  },
  {
    accessorKey: "createdAt",
    header: "Joined",
    cell: ({ row }) => {
      return (
        <span className="text-sm">
          {format(new Date(row.original.createdAt), "MMM d, yyyy")}
        </span>
      )
    },
  },
  {
    id: "actions",
    cell: ({ row, table }) => <ActionsCell row={row} table={table} />,
  },
]

interface EditUserDialogProps {
  user: UserWithProfile
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
  currentUserRole?: string
}

function EditUserDialog({ user, open, onOpenChange, onSuccess, currentUserRole }: EditUserDialogProps) {
  const [isLoading, setIsLoading] = React.useState(false)
  const [formData, setFormData] = React.useState({
    name: user.name || "",
    email: user.email,
    phone: user.profile?.phone || "",
    age: user.profile?.age?.toString() || "",
    location: user.profile?.location || "",
    onboarded: user.profile?.onboarded || false,
  })
  const [editRole, setEditRole] = React.useState<user_role>(user.role)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    try {
      await updateUser(user.id, {
        name: formData.name,
        email: formData.email,
        profile: {
          phone: formData.phone || null,
          age: formData.age ? parseInt(formData.age) : null,
          location: formData.location || null,
          onboarded: formData.onboarded,
        },
      })
      if (currentUserRole === "app_admin" && editRole !== user.role) {
        await updateUserRole(user.id, editRole)
      }
      toast.success("User updated successfully")
      onOpenChange(false)
      onSuccess()
    } catch {
      toast.error("Failed to update user")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-[500px]">
        <SheetHeader>
          <SheetTitle>Edit User</SheetTitle>
          <SheetDescription>
            Update user information and profile details.
          </SheetDescription>
        </SheetHeader>
        <form onSubmit={handleSubmit} className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="phone">Phone</Label>
              <Input
                id="phone"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="age">Age</Label>
              <Input
                id="age"
                type="number"
                value={formData.age}
                onChange={(e) => setFormData({ ...formData, age: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="location">Location</Label>
            <Input
              id="location"
              value={formData.location}
              onChange={(e) => setFormData({ ...formData, location: e.target.value })}
            />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="onboarded"
              checked={formData.onboarded}
              onCheckedChange={(checked) =>
                setFormData({ ...formData, onboarded: checked as boolean })
              }
            />
            <Label htmlFor="onboarded">Onboarded</Label>
          </div>
          {currentUserRole === "app_admin" && (
            <div className="space-y-2">
              <Label htmlFor="role">Role</Label>
              <Select
                value={editRole}
                onValueChange={(val) => setEditRole(val as user_role)}
              >
                <SelectTrigger id="role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="app_admin">App Admin</SelectItem>
                  <SelectItem value="organizer">Organizer</SelectItem>
                  <SelectItem value="venue_owner">Venue Owner</SelectItem>
                  <SelectItem value="attendee">Attendee</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <SheetFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? "Saving..." : "Save Changes"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

export function UsersTable({ data, total, currentUserRole, onRefresh }: UsersTableProps) {
  const router = useRouter()
  const params = useSearchParams()

  /*
   * The search box searches the server, not the page.
   *
   * `getUsers` has always taken a `search` argument and built an insensitive
   * `contains` over name and email, and `page.tsx` has always read `?search=`
   * off the URL and passed it through. Nothing ever set that param: the input
   * called `table.getColumn("user").setFilterValue(...)`, a TanStack filter
   * over the rows already fetched — and the fetch is capped at 50.
   *
   * So with 120 accounts on staging, searching for a real user who happened to
   * sit outside the newest 50 returned **"No users found."** A correct
   * server-side search with no caller, and a box that quietly answered a
   * narrower question than the one it was asked.
   *
   * URL rather than local state, following `leads-inbox.tsx`: a filtered view
   * is then shareable, and it survives the refresh that follows every edit.
   */
  const urlSearch = params.get("search") ?? ""
  const [searchText, setSearchText] = React.useState(urlSearch)

  // Keep the box in step when the URL changes underneath it — back button,
  // a shared link, or the refresh after an edit.
  React.useEffect(() => setSearchText(urlSearch), [urlSearch])

  React.useEffect(() => {
    if (searchText === urlSearch) return
    /*
     * Debounced, because this is a round trip per keystroke otherwise. 300ms is
     * the pause that reads as "finished typing" without feeling laggy.
     */
    const t = setTimeout(() => {
      const next = new URLSearchParams(params.toString())
      if (searchText) next.set("search", searchText)
      else next.delete("search")
      router.replace(`/dashboard/users?${next.toString()}`)
    }, 300)
    return () => clearTimeout(t)
  }, [searchText, urlSearch, params, router])

  const [rowSelection, setRowSelection] = React.useState({})
  const [columnVisibility, setColumnVisibility] =
    React.useState<VisibilityState>({})
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    []
  )
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [pagination, setPagination] = React.useState({
    pageIndex: 0,
    // 20, not 10. Thirty-five accounts over four pages made paging the primary
    // interaction on a screen whose job is finding one person.
    pageSize: 20,
  })

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      columnVisibility,
      rowSelection,
      columnFilters,
      pagination,
    },
    getRowId: (row) => row.id,
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    meta: {
      onRefresh,
      currentUserRole,
    },
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 flex-1">
          <IconSearch className="text-muted-foreground size-4" />
          <Input
            placeholder="Search users..."
            aria-label="Search users by name or email"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            className="max-w-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <IconLayoutColumns />
                <span className="hidden @2xl/main:inline">Columns</span>
                <IconChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {table
                .getAllColumns()
                .filter(
                  (column) =>
                    typeof column.accessorFn !== "undefined" &&
                    column.getCanHide()
                )
                .map((column) => {
                  return (
                    <DropdownMenuCheckboxItem
                      key={column.id}
                      className="capitalize"
                      checked={column.getIsVisible()}
                      onCheckedChange={(value) =>
                        column.toggleVisibility(!!value)
                      }
                    >
                      {column.id}
                    </DropdownMenuCheckboxItem>
                  )
                })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader className="bg-muted sticky top-0 z-10">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  return (
                    <TableHead key={header.id} colSpan={header.colSpan}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody className="**:data-[slot=table-cell]:first:w-8">
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center"
                >
                  No users found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between px-4">
        <div className="text-muted-foreground hidden flex-1 text-sm @2xl/main:flex">
          {rowCountLabel({
            shown: data.length,
            total,
            searching: urlSearch.length > 0,
            selected: table.getFilteredSelectedRowModel().rows.length,
            onPage: table.getFilteredRowModel().rows.length,
          })}
        </div>
        <div className="flex w-full items-center gap-8 @2xl/main:w-fit">
          <div className="hidden items-center gap-2 @2xl/main:flex">
            <Label htmlFor="rows-per-page" className="text-sm font-medium">
              Rows per page
            </Label>
            <Select
              value={`${table.getState().pagination.pageSize}`}
              onValueChange={(value) => {
                table.setPageSize(Number(value))
              }}
            >
              <SelectTrigger size="sm" className="w-20" id="rows-per-page">
                <SelectValue
                  placeholder={table.getState().pagination.pageSize}
                />
              </SelectTrigger>
              <SelectContent side="top">
                {[10, 20, 30, 40, 50].map((pageSize) => (
                  <SelectItem key={pageSize} value={`${pageSize}`}>
                    {pageSize}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex w-fit items-center justify-center text-sm font-medium">
            Page {table.getState().pagination.pageIndex + 1} of{" "}
            {table.getPageCount()}
          </div>
          <div className="ml-auto flex items-center gap-2 @2xl/main:ml-0">
            <Button
              variant="outline"
              className="hidden h-8 w-8 p-0 @2xl/main:flex"
              onClick={() => table.setPageIndex(0)}
              disabled={!table.getCanPreviousPage()}
            >
              <span className="sr-only">Go to first page</span>
              <IconChevronsLeft />
            </Button>
            <Button
              variant="outline"
              className="size-8"
              size="icon"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              <span className="sr-only">Go to previous page</span>
              <IconChevronLeft />
            </Button>
            <Button
              variant="outline"
              className="size-8"
              size="icon"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              <span className="sr-only">Go to next page</span>
              <IconChevronRight />
            </Button>
            <Button
              variant="outline"
              className="hidden size-8 @2xl/main:flex"
              size="icon"
              onClick={() => table.setPageIndex(table.getPageCount() - 1)}
              disabled={!table.getCanNextPage()}
            >
              <span className="sr-only">Go to last page</span>
              <IconChevronsRight />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
