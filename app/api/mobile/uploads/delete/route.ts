import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { deleteFile, ownedObjectKey, type UploadFolder } from "@/lib/tigris"
import {
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
  errorResponse,
  serverErrorResponse,
} from "@/lib/api-response"

/** What a person may delete of their own: their photos, their chat media, their event media. */
const DELETABLE_FOLDERS: UploadFolder[] = ["profile", "chat", "events"]

const deleteSchema = z.object({
  url: z.string().url(),
})

export async function DELETE(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const limited = await rateLimit(request, userLimit("upload", "upload-delete", authUser.userId))
    if (limited) return limited

    const body = await request.json()
    const parsed = deleteSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { url } = parsed.data

    /*
     * Exact host, https, decoded, no traversal, and `{folder}/{userId}/` with
     * the folder from an allow-list -- the binding `checkProfilePhoto` already
     * uses before it fetches anything. The previous parser matched the bucket
     * hostname anywhere in the string and then trusted `split("/")[1]`.
     */
    const key = DELETABLE_FOLDERS.map((f) => ownedObjectKey(url, authUser.userId, f)).find(Boolean)
    if (!key) {
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
