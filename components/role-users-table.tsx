"use client"

import * as React from "react"
import { format } from "date-fns"
import { IconUserPlus, IconUsers } from "@tabler/icons-react"
import type { user_role } from "@prisma/client"

import { CredentialModal } from "@/components/credential-modal"
import { DataTable, type Column } from "@/components/dashboard/data-table"
import { EmptyState } from "@/components/dashboard/primitives"
import { Button } from "@/components/ui/button"
import type { RoleUser } from "@/lib/admin-role-actions"
import type { VenueOwnerFacts } from "@/lib/venue-owner-facts"

interface RoleUsersTableProps {
  users: RoleUser[]
  role: user_role
  roleLabel: string
  detailBasePath: string // e.g. "/dashboard/organisers"
  /** Venue owners only: organisation, venues and a pending claim, per account. */
  facts?: Record<string, VenueOwnerFacts>
  /** The page's StatLine, which shares a row with the table's controls. */
  summary?: React.ReactNode
  /** The page's own links, beside Generate credentials. */
  actions?: React.ReactNode
}

/** A row the table can search: `person` holds both the name and the address. */
type Row = RoleUser & Partial<VenueOwnerFacts> & { person: string }

/**
 * The kit's `RoleUsers` table (admin-supply.jsx): one host account per row.
 *
 * Client, because the columns hand `DataTable` render functions — the boundary
 * rule `__tests__/rsc-boundary.test.ts` holds.
 */
export function RoleUsersTable({ users, role, roleLabel, detailBasePath, facts, summary, actions }: RoleUsersTableProps) {
  const [modalOpen, setModalOpen] = React.useState(false)
  const venueOwners = role === "venue_owner"

  const rows: Row[] = users.map((user) => ({
    ...user,
    ...(facts?.[user.id] ?? {}),
    person: `${user.name ?? ""} ${user.email}`,
  }))

  const columns: Column<Row>[] = [
    {
      key: "person",
      label: venueOwners ? "Owner" : "Organiser",
      primary: true,
      sortType: "string",
      sortValue: (user) => user.name ?? user.email,
      render: (user) => (
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">{user.name ?? "Unnamed"}</span>
          <span className="text-[0.75rem] text-muted-foreground">{user.email}</span>
        </span>
      ),
    },
    ...(venueOwners
      ? [
          {
            key: "org",
            label: "Organisation",
            sortType: "string" as const,
            secondary: true,
            render: (user: Row) => user.org ?? <span className="text-faint-foreground">—</span>,
          },
          { key: "venues", label: "Venues", align: "right" as const, sortType: "number" as const },
        ]
      : []),
    {
      key: "published",
      /*
       * Events they CREATED, which for a venue owner is not the same as events
       * at their venues — that figure needs a join through the building and
       * belongs on the venue index, not on a list of people. Labelled
       * precisely rather than counted wrongly.
       *
       * Published, with drafts beside it rather than folded in.
       * `_count.organized_events` counted every row whatever its status, so ten
       * drafts and nothing live read as the busiest host on the platform.
       */
      label: venueOwners ? "Own events" : "Published",
      align: "right",
      sortType: "number",
      // An organiser who has never shipped is the row that wants a nudge, so it
      // says "never" in warning (the kit's tell) — unless suspended, which is
      // not supply and not a nudge (SCRUM-310, as `neverPublished` counts). A
      // venue owner's own events are incidental, so a zero there is a dash.
      render: (user) =>
        user.published > 0 ? (
          <span className="tabular-nums">{user.published}</span>
        ) : venueOwners || user.suspended ? (
          <span className="text-faint-foreground">—</span>
        ) : (
          <span className="font-medium text-warning">never</span>
        ),
    },
    ...(venueOwners
      ? []
      : [
          {
            key: "drafts",
            label: "Drafts",
            align: "right" as const,
            sortType: "number" as const,
            secondary: true,
            render: (user: Row) =>
              user.drafts > 0 ? (
                <span className="tabular-nums">{user.drafts}</span>
              ) : (
                <span className="text-faint-foreground">—</span>
              ),
          },
          {
            key: "sharePct",
            label: "Share",
            align: "right" as const,
            sortType: "number" as const,
            secondary: true,
            render: (user: Row) =>
              user.published === 0 ? (
                <span className="text-faint-foreground">—</span>
              ) : (
                <span className="tabular-nums">{user.sharePct}%</span>
              ),
          },
        ]),
    {
      key: "lastEventAt",
      label: "Last event",
      align: "right",
      sortType: "string",
      /*
       * Last PUBLISHED event, not the join date. "Joined 5 Sept" is the same for
       * everybody seeded on one afternoon and never changes again.
       *
       * Suspended first: such a row is not a lead to nudge (SCRUM-310). Then a
       * venue claim waiting on us, which is the one thing on a venue owner's row
       * that somebody has to answer.
       */
      render: (user) =>
        user.suspended ? (
          <span className="font-bold text-destructive">Suspended</span>
        ) : user.pendingClaims ? (
          <span className="font-medium text-warning">claim pending</span>
        ) : user.lastEventAt ? (
          format(new Date(user.lastEventAt), "d MMM yyyy")
        ) : (
          <span className="text-faint-foreground">Never published</span>
        ),
    },
  ]

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {summary}
        {/*
          Secondary, not the filled brand button.

          It mints an account and shows a password once. That is the most
          consequential control on a read screen, and it was also the loudest
          thing on it — the only saturated element on a page whose job is
          finding a host. Prominence should track how often something is
          wanted, not how much it does.
        */}
        <div className="ml-auto flex flex-wrap gap-2">
          {actions}
          <Button variant="outline" size="sm" onClick={() => setModalOpen(true)} className="rounded-full">
            <IconUserPlus className="size-4" />
            Generate credentials
          </Button>
        </div>
      </div>

      <DataTable
        label={`${roleLabel}s`}
        columns={columns}
        rows={rows}
        sortable
        search
        searchPlaceholder={`Search ${roleLabel.toLowerCase()}s…`}
        pagination
        defaultPageSize={20}
        rowHref={(user) => `${detailBasePath}/${user.id}`}
        emptyState={
          <EmptyState
            compact
            icon={<IconUsers />}
            title={`No ${roleLabel.toLowerCase()}s yet`}
            description="Use Generate credentials to add one."
          />
        }
      />

      <CredentialModal open={modalOpen} onOpenChange={setModalOpen} role={role} roleLabel={roleLabel} />
    </>
  )
}
