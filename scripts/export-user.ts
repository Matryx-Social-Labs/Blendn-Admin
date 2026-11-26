import type { PrismaClient } from "@prisma/client"

export const EXPORT_CHECKLIST: Record<string, string> = {}

export async function exportUser(_db: PrismaClient, _userId: string): Promise<Record<string, unknown>> {
  throw new Error("not implemented")
}
