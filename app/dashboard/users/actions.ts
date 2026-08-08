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
  profile: {
    id: string
    phone: string | null
    age: number | null
    location: string | null
    interests: string[]
    onboarded: boolean
    created_at: Date
  } | null
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

    const where: Record<string, unknown> = {}

    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        {
          profile: {
            phone: { contains: search, mode: "insensitive" },
          },
        },
      ]
    }

    if (status === "onboarded") {
      where.profile = { onboarded: true }
    } else if (status === "not-onboarded") {
      where.OR = [
        { profile: { is: null } },
        { profile: { onboarded: false } },
      ]
    } else if (status === "verified") {
      where.emailVerified = { not: null }
    } else if (status === "unverified") {
      where.emailVerified = null
    }

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
              interests: true,
              onboarded: true,
              created_at: true,
            },
          },
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

    return { users: users as unknown as UserWithProfile[], total }
  } catch (error) {
    logger.error("Error fetching users", { error: error instanceof Error ? error.message : String(error) })
    throw new Error("Failed to fetch users")
  }
}

export async function getUserById(id: string): Promise<UserWithProfile | null> {
  try {
    // Every other export in this file checks this; this one was missed. It
    // takes an arbitrary user id and returns that person's email, phone, age,
    // location and role, so it was the one worth having.
    const session = await getAuth()
    if (!session?.user || session.user.role !== "app_admin") {
      throw new Error("Not authorised")
    }

    const user = await db.user.findUnique({
      where: { id },
      include: {
        profile: {
          select: {
            id: true,
            phone: true,
            age: true,
            location: true,
            interests: true,
            onboarded: true,
            created_at: true,
          },
        },
        _count: {
          select: {
            organized_events: true,
            event_check_ins: true,
            event_favorites: true,
            chat_messages: true,
          },
        },
      },
    })

    if (user?.profile?.location) {
      user.profile.location = await normalizeLocationToCity(user.profile.location)
    }

    return user as unknown as UserWithProfile | null
  } catch (error) {
    logger.error("Error fetching user", { error: error instanceof Error ? error.message : String(error) })
    throw new Error("Failed to fetch user")
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
            interests: data.profile.interests,
            onboarded: data.profile.onboarded,
          },
        },
      }
    }

    const user = await db.user.update({
      where: { id },
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
  await db.user.update({ where: { id }, data: { role } })
  revalidatePath("/dashboard/users")
  return { success: true }
}

export async function deleteUser(id: string) {
  try {
    const session = await getAuth()
    if (!session?.user || session.user.role !== "app_admin") {
      throw new Error("Forbidden")
    }

    await db.user.delete({
      where: { id },
    })

    revalidatePath("/dashboard/users")
    return { success: true }
  } catch (error) {
    logger.error("Error deleting user", { error: error instanceof Error ? error.message : String(error) })
    throw new Error("Failed to delete user")
  }
}

export async function toggleUserOnboarded(id: string, onboarded: boolean) {
  try {
    const session = await getAuth()
    if (!session?.user || session.user.role !== "app_admin") {
      throw new Error("Forbidden")
    }

    await db.profiles.updateMany({
      where: { id },
      data: { onboarded },
    })

    revalidatePath("/dashboard/users")
    return { success: true }
  } catch (error) {
    logger.error("Error updating user onboarding status", { error: error instanceof Error ? error.message : String(error) })
    throw new Error("Failed to update user onboarding status")
  }
}

export async function getUserStats() {
  try {
    const session = await getAuth()
    if (!session?.user || session.user.role !== "app_admin") {
      throw new Error("Forbidden")
    }

    const [
      totalUsers,
      onboardedUsers,
      verifiedUsers,
      usersThisMonth,
      usersLastMonth,
    ] = await Promise.all([
      db.user.count(),
      db.profiles.count({ where: { onboarded: true } }),
      db.user.count({ where: { emailVerified: { not: null } } }),
      db.user.count({
        where: {
          createdAt: {
            gte: new Date(new Date().setDate(1)),
          },
        },
      }),
      db.user.count({
        where: {
          createdAt: {
            gte: new Date(new Date().setMonth(new Date().getMonth() - 1, 1)),
            lt: new Date(new Date().setDate(1)),
          },
        },
      }),
    ])

    return {
      totalUsers,
      onboardedUsers,
      verifiedUsers,
      usersThisMonth,
      usersLastMonth,
      onboardingRate: totalUsers > 0 ? Math.round((onboardedUsers / totalUsers) * 100) : 0,
      verificationRate: totalUsers > 0 ? Math.round((verifiedUsers / totalUsers) * 100) : 0,
    }
  } catch (error) {
    logger.error("Error fetching user stats", { error: error instanceof Error ? error.message : String(error) })
    throw new Error("Failed to fetch user stats")
  }
}
