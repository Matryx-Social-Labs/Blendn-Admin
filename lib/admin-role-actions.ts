"use server"

import crypto from "crypto"
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
  _count: {
    organized_events: number
  }
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
    current_capacity: number
    max_capacity: number | null
    cover_image_url: string | null
    created_at: Date
  }[]
}

function generatePassword(length = 12): string {
  return crypto.randomBytes(length).toString("base64url").slice(0, length)
}

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
      _count: {
        select: { organized_events: true },
      },
    },
  })

  return users
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
          current_capacity: true,
          max_capacity: true,
          cover_image_url: true,
          created_at: true,
        },
      },
    },
  })

  return user
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
