import { NextResponse } from "next/server"
import { currentUser } from "@/lib/current-user"
import { interestCoverage } from "@/lib/interest-coverage"

export const dynamic = "force-dynamic"

/**
 * Matching coverage: the share of people who turned up who have enough structured interests to be ranked (why it exists:
 * `app/api/health/route.ts`). It was in the public health body, which is unlimited and read by anyone; Railway needs only
 * the status code there (SCRUM-946, owner row 20). An app admin reads it here; anyone else gets the 404 an unknown path gets.
 * The role is the database's, not the cookie's (`currentUser`).
 */
export async function GET() {
  const caller = await currentUser()
  if (caller?.role !== "app_admin") return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json(await interestCoverage(), { headers: { "Cache-Control": "no-store" } })
}
