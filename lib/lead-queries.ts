import type { lead_status, lead_type, Prisma } from "@prisma/client"

import { db } from "@/lib/db"
import { OPEN_LEAD_STATUSES } from "@/lib/leads"

/**
 * Reading the lead inbox.
 *
 * Plain functions, not `"use server"` — everything a server component needs,
 * without turning each one into an endpoint any signed-in user could call. The
 * page is the thing that checks the session.
 */

export interface LeadRow {
  id: string
  status: lead_status
  type: lead_type
  email: string
  name: string | null
  organization: string | null
  city: string | null
  eventTypes: string | null
  source: string
  assignedToName: string | null
  submittedAt: string
  /** Hours since arrival, for leads still untouched. Null once contacted. */
  hoursWaiting: number | null
}

export interface LeadFilters {
  status?: lead_status | "open" | "all"
  type?: lead_type
  assignedTo?: string
  q?: string
  from?: Date
  to?: Date
}

function whereFor(f: LeadFilters): Prisma.leadsWhereInput {
  const where: Prisma.leadsWhereInput = {}

  if (f.status && f.status !== "all") {
    // "open" is the useful default view: work, not history.
    where.status =
      f.status === "open" ? { in: [...OPEN_LEAD_STATUSES] } : { equals: f.status }
  }
  if (f.type) where.type = f.type
  if (f.assignedTo === "unassigned") where.assigned_to = null
  else if (f.assignedTo) where.assigned_to = f.assignedTo

  if (f.from || f.to) {
    where.created_at = { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) }
  }

  const q = f.q?.trim()
  if (q) {
    where.OR = [
      { email: { contains: q, mode: "insensitive" } },
      { name: { contains: q, mode: "insensitive" } },
      { organization: { contains: q, mode: "insensitive" } },
      { city: { contains: q, mode: "insensitive" } },
    ]
  }
  return where
}

export async function getLeads(filters: LeadFilters): Promise<LeadRow[]> {
  const rows = await db.leads.findMany({
    where: whereFor(filters),
    orderBy: { created_at: "desc" },
    take: 500,
    select: {
      id: true,
      status: true,
      type: true,
      email: true,
      name: true,
      organization: true,
      city: true,
      event_types: true,
      source: true,
      submitted_at: true,
      created_at: true,
      contacted_at: true,
      assignee: { select: { name: true } },
    },
  })

  const now = Date.now()
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    type: r.type,
    email: r.email,
    name: r.name,
    organization: r.organization,
    city: r.city,
    eventTypes: r.event_types,
    source: r.source,
    assignedToName: r.assignee?.name ?? null,
    submittedAt: r.submitted_at.toISOString(),
    // Only meaningful while nobody has replied. Once contacted, the number
    // stops being a reproach and starts being noise.
    hoursWaiting:
      r.contacted_at === null
        ? Math.floor((now - r.created_at.getTime()) / 3_600_000)
        : null,
  }))
}

export interface LeadMetrics {
  newThisWeek: number
  /** Median hours from arrival to first contact, last 30 days. */
  medianHoursToContact: number | null
  /** `converted` as a share of everything that arrived in the last 30 days. */
  conversionPct: number | null
  /** Hours the oldest untouched lead has been waiting. The number that stings. */
  oldestUntouchedHours: number | null
}

export async function getLeadMetrics(): Promise<LeadMetrics> {
  const now = Date.now()
  const weekAgo = new Date(now - 7 * 24 * 3_600_000)
  const monthAgo = new Date(now - 30 * 24 * 3_600_000)

  const [newThisWeek, contacted, recent, oldest] = await Promise.all([
    db.leads.count({ where: { created_at: { gte: weekAgo } } }),
    db.leads.findMany({
      where: { contacted_at: { not: null }, created_at: { gte: monthAgo } },
      select: { created_at: true, contacted_at: true },
    }),
    db.leads.findMany({
      where: { created_at: { gte: monthAgo } },
      select: { status: true },
    }),
    db.leads.findFirst({
      where: { contacted_at: null, status: { in: [...OPEN_LEAD_STATUSES] } },
      orderBy: { created_at: "asc" },
      select: { created_at: true },
    }),
  ])

  // Median, not mean: one lead left for three weeks would drag a mean into
  // uselessness while the typical response stayed fine.
  const deltas = contacted
    .map((c) => (c.contacted_at!.getTime() - c.created_at.getTime()) / 3_600_000)
    .sort((a, b) => a - b)
  const medianHoursToContact =
    deltas.length === 0
      ? null
      : deltas.length % 2 === 1
        ? Math.round(deltas[(deltas.length - 1) / 2])
        : Math.round((deltas[deltas.length / 2 - 1] + deltas[deltas.length / 2]) / 2)

  const converted = recent.filter((r) => r.status === "converted").length
  // Spam is excluded from the denominator — counting bot submissions against
  // the team's conversion rate measures the bots, not the team.
  const qualifying = recent.filter((r) => r.status !== "spam").length

  return {
    newThisWeek,
    medianHoursToContact,
    conversionPct: qualifying === 0 ? null : Math.round((converted / qualifying) * 100),
    oldestUntouchedHours: oldest
      ? Math.floor((now - oldest.created_at.getTime()) / 3_600_000)
      : null,
  }
}

/** Admins available in the assign control. */
export async function getLeadAssignees() {
  return db.user.findMany({
    where: { role: "app_admin" },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
  })
}
