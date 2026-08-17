import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { getAuth } from "@/lib/auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  getPresignedUploadUrl,
  validateContentType,
  getMaxFileSize,
  isConfigured,
  UploadFolder,
} from "@/lib/tigris"
import {
  successResponse,
  errorResponse,
  unauthorizedResponse,
  validationErrorResponse,
  serverErrorResponse,
} from "@/lib/api-response"

const presignedUrlSchema = z.object({
  filename: z.string().min(1, "Filename is required").max(255),
  contentType: z.string().min(1, "Content type is required"),
  folder: z.enum(["profile", "chat", "events"]).default("events"),
})

export async function POST(request: NextRequest) {
  try {
    if (!isConfigured()) {
      return errorResponse("File storage is not configured", 503)
    }

    const session = await getAuth()
    if (!session?.user) {
      return unauthorizedResponse("Authentication required")
    }

    // A dashboard session alone is not enough: attendees never upload through
    // the dashboard. Same role gate /api/events POST applies.
    const { role } = session.user
    if (role !== "app_admin" && role !== "organizer" && role !== "venue_owner") {
      return errorResponse("Not authorized to upload", 403)
    }

    /*
     * Same ceiling as the mobile twin, which has always had one.
     *
     * Each call mints a 900-second Tigris PUT URL. Unlimited, one dashboard
     * session could mint them faster than any bucket policy could care, and
     * every issued URL stays valid for fifteen minutes after the session that
     * asked for it is gone.
     */
    const limited = await rateLimit(
      request,
      userLimit("upload", "dashboard-upload-url", session.user.id)
    )
    if (limited) return limited

    const body = await request.json()
    const validation = presignedUrlSchema.safeParse(body)
    if (!validation.success) {
      return validationErrorResponse(validation.error)
    }

    const { filename, contentType, folder } = validation.data
    if (!validateContentType(contentType, folder as UploadFolder)) {
      return errorResponse(
        `Content type "${contentType}" is not allowed for ${folder} uploads`,
        400
      )
    }

    const { uploadUrl, publicUrl, key } = await getPresignedUploadUrl(
      filename,
      contentType,
      folder as UploadFolder,
      session.user.id
    )

    return successResponse({
      uploadUrl,
      publicUrl,
      key,
      maxSize: getMaxFileSize(folder as UploadFolder),
      expiresIn: 900,
    })
  } catch (error) {
    logger.error("Generate presigned URL error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to generate upload URL")
  }
}
