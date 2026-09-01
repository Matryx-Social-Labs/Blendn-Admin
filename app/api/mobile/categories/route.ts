import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { db } from "@/lib/db"
import {
  successResponse,
  unauthorizedResponse,
  serverErrorResponse,
} from "@/lib/api-response"

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return unauthorizedResponse("Authentication required")
    }

    // Get all categories with hierarchy
    const categories = await db.categories.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        icon: true,
        parent_id: true,
        children: {
          select: {
            id: true,
            name: true,
            slug: true,
            description: true,
            icon: true,
          },
          /*
           * Parents were ordered and children were not, which was invisible
           * while the picker flattened everything into one alphabetical list.
           * It stops being invisible now that children render grouped under
           * their parent: Postgres has no default order, so the chips inside
           * "Music" could rearrange between two loads of the same screen.
           */
          orderBy: { name: "asc" },
        },
        _count: {
          select: {
            events: true,
            user_interests: true,
          },
        },
      },
      where: {
        parent_id: null, // Only get top-level categories
      },
      orderBy: {
        name: "asc",
      },
    })

    /*
     * `{ categories }`, not a bare array.
     *
     * Eleven of the thirteen mobile list endpoints answer `data.<name>` —
     * `data.events`, `data.venues`, `data.notifications`. This one and
     * `/conversations` answered `data` directly, so a client had to remember
     * which two were different, and neither could grow a `pagination` sibling
     * without a breaking change.
     *
     * Changed before the client migration rather than after, which is the
     * difference between one client release and two. The shape is recorded in
     * `e2e/__contracts__/mobile-api.json`.
     */
    return successResponse({ categories })
  } catch (error) {
    logger.error("Get categories error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get categories")
  }
}
