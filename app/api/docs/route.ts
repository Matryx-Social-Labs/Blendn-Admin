// Side-effect imports: register all path definitions with the OpenAPI registry
import "@/lib/openapi/paths/mobile-auth"
import "@/lib/openapi/paths/mobile-events"
import "@/lib/openapi/paths/mobile-chat"
import "@/lib/openapi/paths/mobile-conversations"
import "@/lib/openapi/paths/mobile-profiles"
import "@/lib/openapi/paths/mobile-misc"
import "@/lib/openapi/paths/dashboard"
import "@/lib/openapi/paths/system"

import { generateOpenApiDocument } from "@/lib/openapi/registry"

export const dynamic = "force-dynamic"

export async function GET() {
  const doc = generateOpenApiDocument()
  return Response.json(doc)
}
