"use server"

import crypto from "crypto"
import { sharePct } from "@/lib/dashboard-format"
import { distinctAttendeeCounts } from "@/lib/attendee-counts"
import bcrypt from "bcryptjs"
import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"
import type { user_role, event_status } from "@prisma/client"

export interface RoleUser {
  id: string
  name: string | null
  email: string
  image: string | null
  createdAt: Date
  role: user_role
  /** Every event row they created, whatever its status. Kept for the detail page. */
  _count: {
    organized_events: number
  }
  /** Live supply. This is the number a list of hosts is about. */
  published: number
  /** Intent, not supply — see `getRoleUsers`. */
  drafts: number
  /** Most recent PUBLISHED event, ISO. Null when they have never shipped one. */
  lastEventAt: string | null
  /** Share of the platform's published supply. The host-liquidity risk figure. */
  sharePct: number
}

export interface RoleUserWithEvents {
  id: string
  name: string | null
  email: string
  image: string | null
  createdAt: Date
  role: user_role
  organized_events: {
    id: string
    title: string
    status: event_status
    start_time: Date
    end_time: Date
    venue_name: string | null
    city: string | null
    /**
     * Distinct people who actually attended.
     *
     * This was `current_capacity` — a stored counter with **no writer
     * anywhere**, rendered on this screen as "N / capacity". It said whatever
     * it was seeded as, for ever, beside a number that was real.
     */
    attendeeCount: number
    max_capacity: number | null
    cover_image_url: string | null
    created_at: Date
  }[]
}

function generatePassword(length = 12): string {
  return crypto.randomBytes(length).toString("base64url").slice(0, length)
}

/**
 * The people holding a supply-side role, and what they have actually supplied.
 *
 * ## `organized_events` was the wrong number under the right label
 *
 * This counted `_count.organized_events` — every row, whatever its status — and
 * both the per-row `Events` column and the page's `Total Events` card rendered
 * it. So a host with ten drafts and nothing published outranked one with three
 * live events, on a screen whose own description is *"who publishes, and how
 * concentrated it is"*.
 *
 * Published and drafts are separated here for the same reason
 * `hostSupply()` separates them on the overview: a draft is intent, and a
 * published event is supply. `lastEventAt` is published-only on the same
 * argument — a draft nobody shipped is not a sign of life.
 *
 * Curated rows are excluded from neither, and do not need to be: `role` filters
 * this list to organisers, and a curated event's `organizer_id` is the ADMIN
 * who curated it, so it can never land on an organiser's row here.
 */
export async function getRoleUsers(role: user_role): Promise<RoleUser[]> {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") throw new Error("Forbidden")

  const users = await db.user.findMany({
    where: { role },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      createdAt: true,
      role: true,
      _count: { select: { organized_events: true } },
    },
  })

  if (users.length === 0) return []

  const ids = users.map((u) => u.id)
  const [byStatus, lastPublished] = await Promise.all([
    db.events.groupBy({
      by: ["organizer_id", "status"],
      where: { organizer_id: { in: ids }, deleted_at: null },
      _count: { _all: true },
    }),
    db.events.groupBy({
      by: ["organizer_id"],
      where: { organizer_id: { in: ids }, deleted_at: null, status: "published" },
      _max: { start_time: true },
    }),
  ])

  const published = new Map<string, number>()
  const drafts = new Map<string, number>()
  for (const row of byStatus) {
    const target = row.status === "published" ? published : drafts
    target.set(row.organizer_id, (target.get(row.organizer_id) ?? 0) + row._count._all)
  }
  const last = new Map(lastPublished.map((r) => [r.organizer_id, r._max.start_time]))

  const totalPublished = [...published.values()].reduce((n, v) => n + v, 0)

  return users.map((user) => ({
    ...user,
    published: published.get(user.id) ?? 0,
    drafts: drafts.get(user.id) ?? 0,
    lastEventAt: last.get(user.id)?.toISOString() ?? null,
    // Share of PUBLISHED supply; see `sharePct` for the zero-divisor rule.
    sharePct: sharePct(published.get(user.id) ?? 0, totalPublished),
  }))
}

export async function getRoleUserById(id: string): Promise<RoleUserWithEvents | null> {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") throw new Error("Forbidden")

  const user = await db.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      createdAt: true,
      role: true,
      organized_events: {
        where: { deleted_at: null },
        orderBy: { created_at: "desc" },
        select: {
          id: true,
          title: true,
          status: true,
          start_time: true,
          end_time: true,
          venue_name: true,
          city: true,
          max_capacity: true,
          cover_image_url: true,
          created_at: true,
        },
      },
    },
  })

  if (!user) return null

  /*
   * Counted, never stored. `lib/attendee-counts.ts` owns "how many people",
   * and it folds distinct users per occurrence — so a three-day event does not
   * read three times high, which a stored counter could never get right anyway
   * because nothing maintained it.
   */
  const counts = await distinctAttendeeCounts(user.organized_events.map((e) => e.id))

  return {
    ...user,
    organized_events: user.organized_events.map((e) => ({
      ...e,
      attendeeCount: counts.get(e.id) ?? 0,
    })),
  }
}

export async function createRoleUser(
  name: string,
  email: string,
  role: user_role
): Promise<{ name: string; email: string; password: string }> {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") throw new Error("Forbidden")

  const existing = await db.user.findUnique({ where: { email } })
  if (existing) throw new Error("Email already in use")

  const plainPassword = generatePassword(12)
  const hashedPassword = await bcrypt.hash(plainPassword, 12)

  await db.user.create({
    data: { name, email, password: hashedPassword, role },
  })

  revalidatePath(`/dashboard/organisers`)
  revalidatePath(`/dashboard/venue-owners`)

  return { name, email, password: plainPassword }
}

export async function updateEventStatus(eventId: string, status: event_status) {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") throw new Error("Forbidden")

  await db.events.update({
    where: { id: eventId },
    data: { status },
  })

  revalidatePath("/dashboard/organisers")
  revalidatePath("/dashboard/venue-owners")
  revalidatePath("/dashboard/events")
  return { success: true }
}
