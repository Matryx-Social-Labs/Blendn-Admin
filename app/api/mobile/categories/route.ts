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

    return successResponse(categories)
  } catch (error) {
    console.error("Get categories error:", error)
    return serverErrorResponse("Failed to get categories")
  }
}
