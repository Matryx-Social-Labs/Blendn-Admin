import { NextRequest } from "next/server"
import { z } from "zod"
import { getAuth } from "@/lib/auth"
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
    console.error("Generate presigned URL error:", error)
    return serverErrorResponse("Failed to generate upload URL")
  }
}
