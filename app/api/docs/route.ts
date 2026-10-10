// Side-effect imports: register all path definitions with the OpenAPI registry
import "@/lib/openapi/paths/mobile-auth"
import "@/lib/openapi/paths/mobile-events"
import "@/lib/openapi/paths/mobile-chat"
import "@/lib/openapi/paths/mobile-conversations"
import "@/lib/openapi/paths/mobile-profiles"
import "@/lib/openapi/paths/mobile-misc"
import "@/lib/openapi/paths/mobile-friends"
import "@/lib/openapi/paths/mobile-crews"
import "@/lib/openapi/paths/dashboard"
import "@/lib/openapi/paths/system"

import { requireAdmin } from "@/lib/current-user"
import { generateOpenApiDocument } from "@/lib/openapi/registry"

export const dynamic = "force-dynamic"

/**
 * The complete map of the mobile API: admins only (step 18, L1). The middleware
 * gates it on the cookie's role; this asks the database too, so the route does
 * not lean on a check in another file. A 404, not a 401: "protected" tells a
 * stranger a spec lives here, which is half the disclosure.
 */
export async function GET() {
  try {
    await requireAdmin()
  } catch {
    return new Response("Not found", { status: 404 })
  }
  const doc = generateOpenApiDocument()
  return Response.json(doc)
}
