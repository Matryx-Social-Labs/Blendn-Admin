"use server"

import { getAuth } from "@/lib/auth"
import { admitAtDoor, doorCount, type DoorAnswer } from "@/lib/ticket-door"

/** What the door's phone is told: `DoorAnswer` with its times as ISO strings, and the new count after a let-in. */
export type DoorReply =
  | { kind: "let_in"; code: string; typeName: string; nth: number; of: number; at: string; count: { inside: number; of: number } }
  | { kind: "used"; code: string; typeName: string; at: string }
  | { kind: "invalid"; code: string | null }
  | { kind: "wait"; retryAfter: number }
  | { kind: "not_authorized" }
  | { kind: "off" }

/**
 * The door's one action (SCRUM-1014): `admitAtDoor` authorizes (canOperate),
 * limits (per operator, per event) and redeems in one write. A typed code or
 * a scanned QR; never a name back.
 */
export async function admitTicket(eventId: string, credential: { code: string } | { qr: string }): Promise<DoorReply> {
  const session = await getAuth()
  if (!session?.user) return { kind: "not_authorized" }
  const cred = "qr" in credential ? { qr: String(credential.qr).slice(0, 200) } : { code: String(credential.code).slice(0, 12) }
  const a: DoorAnswer = await admitAtDoor(eventId, { id: session.user.id, role: session.user.role }, cred)
  if (a.kind === "let_in") return { ...a, at: a.at.toISOString(), count: await doorCount(eventId) }
  if (a.kind === "used") return { ...a, at: a.at.toISOString() }
  return a
}
