import type { user_role } from "@prisma/client"

export function canAccessDashboard(role: user_role): boolean {
  return role === "app_admin" || role === "organizer" || role === "venue_owner"
}

export function canManageEvent(
  role: user_role,
  userId: string,
  organizerId: string
): boolean {
  if (role === "app_admin") return true
  if (role === "organizer") return userId === organizerId
  return false
}

export function canModerateChat(
  role: user_role,
  userId: string,
  organizerId: string
): boolean {
  if (role === "app_admin") return true
  if (role === "organizer" || role === "venue_owner") return userId === organizerId
  return false
}

export function canSendSystemMessages(role: user_role): boolean {
  return role === "app_admin"
}

export function canSendPushNotifications(role: user_role): boolean {
  return role === "app_admin"
}
