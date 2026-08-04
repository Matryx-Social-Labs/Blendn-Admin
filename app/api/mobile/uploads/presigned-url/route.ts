import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { db } from "@/lib/db"
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
  folder: z.enum(["profile", "chat", "events"]).default("profile"),
})

export async function POST(request: NextRequest) {
  try {
    // Check if Tigris is configured
    if (!isConfigured()) {
      return errorResponse("File storage is not configured", 503)
    }

    const user = await getAuthenticatedUser(request)
    if (!user) {
      return unauthorizedResponse("Authentication required")
    }

    const body = await request.json()

    // Validate request body
    const validation = presignedUrlSchema.safeParse(body)
    if (!validation.success) {
      return validationErrorResponse(validation.error)
    }

    const { filename, contentType, folder } = validation.data

    // Restrict event uploads to organizers and admins
    if (folder === "events") {
      const dbUser = await db.user.findUnique({
        where: { id: user.userId },
        select: { role: true },
      })
      if (!dbUser || !["app_admin", "organizer", "venue_owner"].includes(dbUser.role)) {
        return errorResponse("You do not have permission to upload event files", 403)
      }
    }

    // Validate content type for the folder
    if (!validateContentType(contentType, folder as UploadFolder)) {
      return errorResponse(
        `Content type "${contentType}" is not allowed for ${folder} uploads`,
        400
      )
    }

    // Get the presigned URL
    const { uploadUrl, publicUrl, key } = await getPresignedUploadUrl(
      filename,
      contentType,
      folder as UploadFolder,
      user.userId
    )

    return successResponse({
      uploadUrl,
      publicUrl,
      key,
      maxSize: getMaxFileSize(folder as UploadFolder),
      expiresIn: 900, // 15 minutes
    })
  } catch (error) {
    logger.error("Generate presigned URL error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to generate upload URL")
  }
}
