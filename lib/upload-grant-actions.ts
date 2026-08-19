"use server"

import { z } from "zod"

import { auditLog } from "@/lib/audit-log"
import { getAuth } from "@/lib/auth"
import { SPONSORSHIP } from "@/lib/constants"
import { db } from "@/lib/db"
import { actorFor, resolveSponsorGrant } from "@/lib/org-membership"
import { broadcastMayCarryMedia } from "@/lib/rbac"
import { getPresignedUploadUrl, headObject, isConfigured, pinnedUrl } from "@/lib/tigris"

/**
 * Media on a sponsored creative, and where the bytes came from.
 *
 * ## Why a grant table exists at all
 *
 * A presigned PUT hands out write access to a key. Without a record of who was
 * given which key, for what, and how big it was allowed to be, the only thing
 * standing between an issued URL and an arbitrary 5GB object is whatever the
 * storage happens to enforce — and `media_url` on a creative would be a string a
 * client asserted rather than a fact the server established.
 *
 * So: issue a grant, let the client PUT, then come back and *validate* against
 * the grant before the URL is written anywhere. The object is checked after it
 * exists, which is the only moment its real size and type are knowable.
 *
 * ## Why the version is pinned and the checksum is not invented
 *
 * A content-addressed key is impossible here — the key has to be chosen before
 * the bytes exist. So the defence against the same key being overwritten *after*
 * review is to pin the object version that was reviewed and serve that one.
 *
 * The checksum is recorded only when the storage computed one. An ETag is an MD5
 * for a single-part upload and a hash-of-hashes for a multipart one, so it
 * changes meaning with the upload strategy; writing it into a column called
 * `checksum` would look like provenance and be nothing of the kind.
 *
 * ## Why only sponsored media
 *
 * `broadcastMayCarryMedia` says so, and the reason is in docs/API.md: the room is
 * pseudonymous, and a photograph is an identity — of whoever is *in* it, who is
 * not always the person posting. Sponsored artwork depicts nobody in the room,
 * which is exactly what makes it the exception.
 */

const GRANT_TTL_MINUTES = 30

const requestSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp", "video/mp4"]),
  /** Declared up front so an oversized upload is refused before it is made. */
  bytes: z.number().int().positive(),
})

/** The ceiling for this kind of media. Video gets more room; an image does not need it. */
function ceilingFor(contentType: string): number {
  return contentType.startsWith("video/")
    ? SPONSORSHIP.MAX_VIDEO_BYTES
    : SPONSORSHIP.MAX_IMAGE_BYTES
}

export interface UploadGrant {
  uploadUrl: string
  key: string
  expiresAt: Date
  maxBytes: number
}

/**
 * Issue a grant and a presigned PUT for one sponsored creative.
 *
 * Scoped to the organisation, not the person: a colleague at the same sponsor
 * has to be able to finish an upload the other one started, and the grant is
 * validated against the org later.
 */
export async function requestCreativeUpload(
  eventId: string,
  input: unknown
): Promise<UploadGrant> {
  const session = await getAuth()
  if (!session?.user) throw new Error("Unauthorized")

  if (!isConfigured()) throw new Error("File storage is not configured")

  const parsed = requestSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Tell us what you are uploading")
  }
  const { filename, contentType, bytes } = parsed.data

  // The rule lives in rbac, not here, so the one table decides it.
  if (!broadcastMayCarryMedia("sponsored")) throw new Error("Forbidden")

  const actor = await actorFor(session.user)
  const grantHolder = await resolveSponsorGrant(actor, eventId)
  /*
   * An admin has no grant by design. Everyone else must hold both halves — the
   * `may_sponsor` flag and an approved placement at this event — on ONE
   * organisation, which is what `resolveSponsorGrant` proves in a single query.
   */
  const orgId = grantHolder?.orgId ?? (actor.role === "app_admin" ? actor.orgIds[0] : undefined)
  if (!orgId) throw new Error("Forbidden")

  const ceiling = ceilingFor(contentType)
  if (bytes > ceiling) {
    throw new Error(
      `That file is ${Math.round(bytes / 1024 / 1024)}MB. The limit is ${Math.round(ceiling / 1024 / 1024)}MB.`
    )
  }

  const { uploadUrl, key } = await getPresignedUploadUrl(
    filename,
    contentType,
    "sponsored",
    session.user.id,
    { checksum: true }
  )

  const expiresAt = new Date(Date.now() + GRANT_TTL_MINUTES * 60_000)

  await db.upload_grants.create({
    data: {
      user_id: session.user.id,
      org_id: orgId,
      key,
      content_type: contentType,
      // The DECLARED size becomes the ceiling for this specific object, capped
      // by the format's own limit. Declaring 1MB and uploading 90 is refused at
      // validation.
      max_bytes: Math.min(bytes, ceiling),
      expires_at: expiresAt,
    },
  })

  return { uploadUrl, key, expiresAt, maxBytes: Math.min(bytes, ceiling) }
}

export interface AttachedMedia {
  creativeId: string
  mediaUrl: string
  mediaType: string
}

/**
 * Attach an uploaded object to a campaign, as a new creative revision.
 *
 * Everything is re-checked against the object as it actually exists — its size,
 * its type, its version — because between the grant and this call the client
 * controlled the bytes. The grant says what was permitted; the HEAD says what
 * arrived.
 */
export async function attachCreativeMedia(
  campaignId: string,
  key: string
): Promise<AttachedMedia> {
  const session = await getAuth()
  if (!session?.user) throw new Error("Unauthorized")

  const campaign = await db.event_sponsored_messages.findUnique({
    where: { id: campaignId },
    select: { id: true, event_id: true, content: true, sponsor_id: true },
  })
  if (!campaign) throw new Error("Campaign not found")

  const actor = await actorFor(session.user)
  const grantHolder = await resolveSponsorGrant(actor, campaign.event_id)
  const orgId = grantHolder?.orgId ?? (actor.role === "app_admin" ? actor.orgIds[0] : undefined)
  if (!orgId) throw new Error("Forbidden")

  const grant = await db.upload_grants.findUnique({
    where: { key },
    select: {
      id: true,
      org_id: true,
      content_type: true,
      max_bytes: true,
      expires_at: true,
      consumed_at: true,
    },
  })
  if (!grant) throw new Error("That upload was not issued by us.")

  /*
   * The org that was granted the key, not the org of whoever is calling now. A
   * key is a capability; letting a second organisation redeem one turns an
   * upload URL into a way to attribute somebody else's artwork to your brand.
   */
  if (grant.org_id !== orgId) throw new Error("That upload belongs to another organisation.")
  if (grant.consumed_at) throw new Error("That upload has already been used.")
  if (grant.expires_at <= new Date()) throw new Error("That upload expired. Try again.")

  const facts = await headObject(key)
  if (!facts) throw new Error("We cannot find that file. Did the upload finish?")

  if (facts.bytes > grant.max_bytes) {
    throw new Error(
      `That file is bigger than the ${Math.round(grant.max_bytes / 1024 / 1024)}MB it was cleared for.`
    )
  }
  /*
   * A presigned PUT signs the content type, so this should not diverge — which
   * is precisely why a divergence is worth refusing rather than shrugging at.
   * The type decides whether the client renders a poster and a tap-to-play
   * control or an inline image.
   */
  if (facts.contentType && facts.contentType !== grant.content_type) {
    throw new Error("That file is not the type it was cleared for.")
  }
  // Not a hard failure: an object with no bytes is a failed upload, not an
  // attack, and the recovery is the same as any other incomplete one.
  if (facts.bytes === 0) throw new Error("That file is empty. Did the upload finish?")

  const mediaUrl = pinnedUrl(key, facts.versionId)

  const created = await db.$transaction(async (tx) => {
    /*
     * A new revision, and the campaign goes back to pending in the same write.
     *
     * Attaching artwork to an approved campaign is an edit to the creative by
     * any reading — it is the part an attendee actually looks at. Letting it
     * inherit the text's approval would make review decorative for anyone who
     * can upload.
     */
    const creative = await tx.sponsored_creatives.create({
      data: {
        message_id: campaignId,
        content: campaign.content,
        media_url: mediaUrl,
        media_type: grant.content_type,
        media_checksum: facts.checksumSha256,
        media_version_id: facts.versionId,
      },
      select: { id: true },
    })

    await tx.event_sponsored_messages.update({
      where: { id: campaignId },
      data: {
        moderation_status: "pending",
        is_active: false,
        next_send_at: null,
        claim_token: null,
        claimed_at: null,
      },
    })

    await tx.upload_grants.update({
      where: { id: grant.id },
      data: {
        consumed_at: new Date(),
        checksum: facts.checksumSha256,
        version_id: facts.versionId,
      },
    })

    return creative
  })

  auditLog({
    userId: session.user.id,
    action: "creative.media_attached",
    resource: "sponsored_creatives",
    resourceId: created.id,
    details: {
      campaignId,
      eventId: campaign.event_id,
      sponsorId: campaign.sponsor_id,
      key,
      bytes: facts.bytes,
      contentType: grant.content_type,
      versionId: facts.versionId,
      // Recorded as a fact, including its absence: "the storage did not give us
      // one" is different from "we did not ask".
      checksum: facts.checksumSha256,
    },
  })

  return { creativeId: created.id, mediaUrl, mediaType: grant.content_type }
}
