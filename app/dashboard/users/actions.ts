"use server"

import { logger } from "@/lib/logger"
import { db } from "@/lib/db"
import { normalizeLocationToCity } from "@/lib/location"
import { revalidatePath } from "next/cache"
import { getAuth } from "@/lib/auth"
import type { user_role } from "@prisma/client"

export interface UserWithProfile {
  id: string
  name: string | null
  email: string
  emailVerified: Date | null
  image: string | null
  role: user_role
  createdAt: Date
  updatedAt: Date
  /** Set by the mobile account route's scrub-and-keep erasure; never unset. */
  deletedAt: Date | null
  suspended_at: Date | null
  profile: {
    id: string
    phone: string | null
    age: number | null
    location: string | null
    onboarded: boolean
    created_at: Date
  } | null
  /**
   * The structured graph, not `profiles.interests`.
   *
   * Two columns have carried this name. `profiles.interests` is free text and
   * is read by nothing the product does — matching ranks on `user_interests`,
   * and the app has written only that since the edit-profile screen was fixed.
   * So the free-text column froze at whatever a pre-change client last wrote.
   *
   * Measured on staging the day this changed: 37 profiles had a non-empty
   * free-text column, 30 had a real graph, and **one** had both. This screen
   * was rendering a dash for 29 people who have interests and a list for 36
   * whose list matching cannot see.
   *
   * Top-level rather than under `profile`, matching the mobile payload, where
   * the same split exists and the same naming caused the same bug in the
   * client (`edit-profile.tsx` used to write the wrong one).
   */
  interests: string[]
  _count: {
    organized_events: number
    event_check_ins: number
    event_favorites: number
    chat_messages: number
  }
}

export async function getUsers(
  search?: string,
  status?: string,
  limit: number = 50,
  offset: number = 0
): Promise<{ users: UserWithProfile[]; total: number }> {
  try {
    const session = await getAuth()
    if (!session?.user || session.user.role !== "app_admin") {
      throw new Error("Forbidden")
    }

    /*
     * ANDed clauses, because two of them are ORs. `search` and `not-onboarded`
     * each used to assign `where.OR`, so the second silently replaced the
     * first and a search combined with that filter searched nothing.
     */
    const clauses: Record<string, unknown>[] = []

    if (search) {
      clauses.push({
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
          {
            profile: {
              phone: { contains: search, mode: "insensitive" },
            },
          },
        ],
      })
    }

    /*
     * Deleted accounts are out of the list unless asked for. Erasure keeps the
     * row (see the note above `updateUser`), so without this an admin looking
     * for "who is on the platform" sees a person who is not, and could open the
     * edit dialog on them.
     */
    if (status === "deleted") {
      clauses.push({ deletedAt: { not: null } })
    } else {
      clauses.push({ deletedAt: null })
    }

    if (status === "onboarded") {
      clauses.push({ profile: { onboarded: true } })
    } else if (status === "not-onboarded") {
      clauses.push({
        OR: [{ profile: { is: null } }, { profile: { onboarded: false } }],
      })
    } else if (status === "verified") {
      clauses.push({ emailVerified: { not: null } })
    } else if (status === "unverified") {
      clauses.push({ emailVerified: null })
    } else if (status === "suspended") {
      clauses.push({ suspended_at: { not: null } })
    }

    const where = { AND: clauses }

    const [users, total] = await Promise.all([
      db.user.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { createdAt: "desc" },
        include: {
          profile: {
            select: {
              id: true,
              phone: true,
              age: true,
              location: true,
              onboarded: true,
              created_at: true,
            },
          },
          user_interests: { select: { category: { select: { name: true } } } },
          _count: {
            select: {
              organized_events: true,
              event_check_ins: true,
              event_favorites: true,
              chat_messages: true,
            },
          },
        },
      }),
      db.user.count({ where }),
    ])

    await Promise.all(
      users.map(async (user) => {
        if (!user.profile?.location) return
        const normalized = await normalizeLocationToCity(user.profile.location)
        user.profile.location = normalized
      })
    )

    const shaped = users.map((user) => ({
      ...user,
      interests: user.user_interests.map((ui) => ui.category.name),
    }))

    return { users: shaped as unknown as UserWithProfile[], total }
  } catch (error) {
    logger.error("Error fetching users", { error: error instanceof Error ? error.message : String(error) })
    throw new Error("Failed to fetch users")
  }
}

export async function updateUser(
  id: string,
  data: {
    name?: string
    email?: string
    profile?: {
      phone?: string | null
      age?: number | null
      location?: string | null
      interests?: string[]
      onboarded?: boolean
    }
  }
) {
  try {
    const session = await getAuth()
    if (!session?.user || session.user.role !== "app_admin") {
      throw new Error("Forbidden")
    }

    const normalizedLocation = await normalizeLocationToCity(data.profile?.location)

    const updateData: Record<string, unknown> = {}
    if (data.name !== undefined) updateData.name = data.name
    if (data.email !== undefined) updateData.email = data.email

    if (data.profile) {
      updateData.profile = {
        upsert: {
          create: {
            phone: data.profile.phone,
            age: data.profile.age,
            location: normalizedLocation,
            interests: data.profile.interests || [],
            onboarded: data.profile.onboarded ?? false,
          },
          update: {
            phone: data.profile.phone,
            age: data.profile.age,
            location: normalizedLocation,
            /*
             * Conditional, because the only caller never sends it.
             *
             * The Edit User dialog collects name, email, phone, age, location
             * and onboarded — not interests — so this expression was always
             * `undefined`, and under `strictUndefinedChecks` that is a runtime
             * error rather than "leave the column alone". Every admin edit of
             * a user with an existing profile row returned 500 and the toast
             * read "Failed to update user".
             *
             * Sixth instance of this class, and the first the shorthand
             * ratchet could not see: it scans literal `data: {` blocks and
             * this write is assembled in `updateData` first.
             */
            ...(data.profile.interests !== undefined && { interests: data.profile.interests }),
            onboarded: data.profile.onboarded,
          },
        },
      }
    }

    // `deletedAt: null` in the where: an erased account cannot be edited back
    // into existence. The row menu is hidden for those rows, but a server
    // action is callable without a menu. P2025 surfaces as the generic error.
    const user = await db.user.update({
      where: { id, deletedAt: null },
      data: updateData,
      include: {
        profile: true,
      },
    })

    revalidatePath("/dashboard/users")
    return { success: true, user }
  } catch (error) {
    logger.error("Error updating user", { error: error instanceof Error ? error.message : String(error) })
    throw new Error("Failed to update user")
  }
}

export async function updateUserRole(id: string, role: user_role) {
  const session = await getAuth()
  if (!session?.user || session.user.role !== "app_admin") {
    throw new Error("Forbidden")
  }
  await db.user.update({ where: { id, deletedAt: null }, data: { role } })
  revalidatePath("/dashboard/users")
  return { success: true }
}

/*
 * `deleteUser` is deliberately absent.
 *
 * It used to be `db.user.delete({ where: { id } })`, one click behind a
 * dropdown. The schema forbids that in writing (`prisma/schema.prisma:28-32`):
 * deleting a host cascades their events, every check-in and every chat message,
 * destroying other people's history to punish one person. It also orphaned the
 * `message_reports` rows *about* that person, which carry no foreign key.
 *
 * The two supported paths, both of which keep the row:
 *
 *   suspension  reversible, writes audit_logs, `suspended_at`/`suspended_by`
 *               — app/dashboard/moderation/reports/actions.ts
 *   erasure     the scrub-and-keep transaction the mobile account route uses,
 *               which nulls PII and sets `deletedAt` while preserving FKs
 *
 * If a GDPR erasure request arrives, use the second. Do not reintroduce a hard
 * delete: there is no undo and it takes other users' data with it.
 */

/**
 * The four numbers worth putting above a list of people.
 *
 * ## What went, and why
 *
 * This screen had four bordered KPI cards at identical visual weight — the
 * exact "eleven things, nothing primary" arrangement `DESIGN_SYSTEM.md` records
 * as the failure the redesign existed to fix, still standing on one page. Three
 * of the four also answered questions this screen is not for:
 *
 *   - **Onboarding rate** is stage two of the loop, drawn properly on the
 *     overview with the six stages either side of it that give it meaning.
 *   - **"N new this month"** sat under a total that was mostly the same number.
 *   - **Growth, "% vs last month"**, computed `usersLastMonth > 0 ? … : 0`, so a
 *     month with no prior signups rendered **0%** — and on staging that is
 *     exactly what it showed: *"Growth 0%"* beside *"35 new this month"*. An
 *     invented +500% would at least look wrong. An invented 0% looks plausible
 *     and says the opposite of the truth. `lib/metric-delta.ts` returns null for
 *     this case and the overview's tiles have honoured it for months.
 *
 * Both month queries also used `new Date().setDate(1)`, which keeps the current
 * time of day — so "this month" began on the 1st at whatever o'clock it happens
 * to be, and the counts moved as the afternoon wore on.
 *
 * ## What replaced them
 *
 * `suspended`, which none of the four carried. It is the only figure on a list
 * of accounts that means somebody should look at something.
 */
export async function getUserStats() {
  try {
    const session = await getAuth()
    if (!session?.user || session.user.role !== "app_admin") {
      throw new Error("Forbidden")
    }

    // "Accounts" means people on the platform; an erased row is not one.
    const live = { deletedAt: null }
    const [total, onboarded, verified, suspended, deleted] = await Promise.all([
      db.user.count({ where: live }),
      db.profiles.count({ where: { onboarded: true, user: live } }),
      db.user.count({ where: { ...live, emailVerified: { not: null } } }),
      db.user.count({ where: { ...live, suspended_at: { not: null } } }),
      db.user.count({ where: { deletedAt: { not: null } } }),
    ])

    return { total, onboarded, verified, suspended, deleted }
  } catch (error) {
    logger.error("Error fetching user stats", {
      error: error instanceof Error ? error.message : String(error),
    })
    throw new Error("Failed to fetch user stats")
  }
}
