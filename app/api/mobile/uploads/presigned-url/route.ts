import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  getPresignedUploadUrl,
  validateContentType,
  getMaxFileSize,
  isConfigured,
  UPLOADS_UNAVAILABLE,
} from "@/lib/tigris"
import {
  successResponse,
  errorResponse,
  unauthorizedResponse,
  validationErrorResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { readJson } from "@/lib/api-input"
import { sendsUploadSize } from "@/lib/mobile-gate"

const presignedUrlSchema = z.object({
  filename: z.string().min(1, "Filename is required").max(255),
  contentType: z.string().min(1, "Content type is required"),
  // The app uploads profile photos and chat media; event media is the dashboard's (/api/uploads/presigned-url).
  folder: z.enum(["profile", "chat"]).default("profile"),
  /** Byte length of the file about to be PUT. Signed into the URL when sent (API M6). */
  size: z.number().int().min(1).optional(),
})

export async function POST(request: NextRequest) {
  try {
    // Check if Tigris is configured
    if (!isConfigured()) {
      return errorResponse(UPLOADS_UNAVAILABLE, 503)
    }

    const user = await getAuthenticatedUser(request)
    if (!user) {
      return unauthorizedResponse("Authentication required")
    }

    const limited = await rateLimit(request, userLimit("upload", "upload-url", user.userId))
    if (limited) return limited

    const body = await readJson(request)

    // Validate request body
    const validation = presignedUrlSchema.safeParse(body)
    if (!validation.success) {
      return validationErrorResponse(validation.error)
    }

    const { filename, contentType, folder, size } = validation.data

    // From the build that sends it, `size` is required: omitting it was the way to an unbound URL (API M6).
    if (size === undefined && sendsUploadSize(request.headers.get("x-app-version"))) {
      return errorResponse("size is required", 400)
    }

    // Validate content type for the folder
    if (!validateContentType(contentType, folder)) {
      return errorResponse(
        `Content type "${contentType}" is not allowed for ${folder} uploads`,
        400
      )
    }

    if (size !== undefined && size > getMaxFileSize(folder)) {
      return errorResponse(`File is larger than the ${getMaxFileSize(folder)} byte limit for ${folder} uploads`, 400)
    }

    // Get the presigned URL
    const { uploadUrl, publicUrl, key } = await getPresignedUploadUrl(
      filename,
      contentType,
      folder,
      user.userId,
      { size }
    )

    return successResponse({
      uploadUrl,
      publicUrl,
      key,
      maxSize: getMaxFileSize(folder),
      expiresIn: 900, // 15 minutes
    })
  } catch (error) {
    logger.error("Generate presigned URL error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to generate upload URL")
  }
}
