// ── Upload helpers ──────────────────────────────────────────────────────────
// Requests a presigned Tigris/S3 upload URL from the admin API, then PUTs the
// file directly to storage. Uses XMLHttpRequest (instead of fetch) so upload
// progress can be surfaced in the UI via onProgress.

export async function requestPresignedUrl(file: File) {
  const res = await fetch("/api/uploads/presigned-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, contentType: file.type, folder: "events" }),
  })
  if (!res.ok) throw new Error("Failed to request upload URL")
  const payload = await res.json()
  if (!payload?.success || !payload?.data?.uploadUrl) throw new Error("No upload URL")
  return payload.data as { uploadUrl: string; publicUrl: string }
}

export async function uploadFile(
  file: File,
  onProgress?: (percent: number) => void
): Promise<string> {
  const { uploadUrl, publicUrl } = await requestPresignedUrl(file)

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("PUT", uploadUrl)
    xhr.setRequestHeader("Content-Type", file.type)

    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100))
      }
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
      } else {
        reject(new Error("Upload failed"))
      }
    }
    xhr.onerror = () => reject(new Error("Upload failed"))

    xhr.send(file)
  })

  return publicUrl
}
