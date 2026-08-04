import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { deleteFile, extractKeyFromUrl } from "@/lib/tigris"
import {
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
  errorResponse,
  serverErrorResponse,
} from "@/lib/api-response"

const deleteSchema = z.object({
  url: z.string().url(),
})

export async function DELETE(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const body = await request.json()
    const parsed = deleteSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { url } = parsed.data

    // Extract the key from the URL
    const key = extractKeyFromUrl(url)
    if (!key) {
      return errorResponse("Invalid file URL")
    }

    // Verify the file belongs to the user by checking the path prefix
    // Files are stored as: {folder}/{userId}/{timestamp}-{random}-{filename}
    const pathParts = key.split("/")
    if (pathParts.length < 2) {
      return errorResponse("Invalid file path")
    }

    const userIdInPath = pathParts[1]
    if (userIdInPath !== authUser.userId) {
      return errorResponse("You do not have permission to delete this file", 403)
    }

    // Delete the file
    await deleteFile(key)

    return successResponse({ deleted: true })
  } catch (error) {
    logger.error("Delete file error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to delete file")
  }
}
