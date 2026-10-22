/**
 * A photo's picture without what rides along with it (SCRUM-626).
 *
 * A phone writes where a photo was taken into its EXIF block, and nothing
 * here removed it: a seal copied the uploaded bytes as they were, so a DM
 * photo handed the sender's position to the recipient and a profile photo
 * handed it to anyone. The app re-encodes before uploading (R9), and this is
 * the server's half, so a client that does not is not a leak.
 *
 * Lossless: segments and chunks are dropped, never decoded, so the picture
 * is the bytes it was. What is kept is a short list of what drawing it needs
 * — anything unknown goes, since an unknown block is where metadata hides.
 * Bytes that do not walk to their end as a JPEG, PNG or WebP are not a photo
 * and come back null, whatever the upload said it was.
 *
 * What is kept is copied into one buffer the size of the input: a hostile
 * file of a million 4-byte segments would otherwise be a million slices.
 *
 * ponytail: EXIF Orientation goes with the rest, so a camera original that
 * relied on it shows rotated. The app re-encodes upright first; carry the one
 * tag across if a client ever sends originals. An ICC profile is kept whole,
 * and its description is free text: a sender can hide words in their own
 * photo, but no camera puts a position there.
 */
export type CleanImage = { bytes: Uint8Array; contentType: "image/jpeg" | "image/png" | "image/webp" }

export function stripImageMetadata(input: Uint8Array): CleanImage | null {
  const b = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  const clean = (bytes: Uint8Array | null, contentType: CleanImage["contentType"]) => (bytes ? { bytes, contentType } : null)
  if (b[0] === 0xff && b[1] === 0xd8) return clean(stripJpeg(b), "image/jpeg")
  if (b.subarray(0, 8).equals(PNG_SIGNATURE)) return clean(stripPng(b), "image/png")
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return clean(stripWebp(b), "image/webp")
  return null
}

/** Where kept bytes go: never longer than the input, and a fresh buffer, so the caller's bytes are untouched. */
function writer(b: Buffer) {
  const out = Buffer.allocUnsafe(b.length)
  let n = 0
  return {
    keep: (start: number, end: number) => (n += b.copy(out, n, start, end)),
    at: () => n,
    out,
    done: () => out.subarray(0, n),
  }
}

/** The picture's own markers: SOFn, DHT, DAC (0xC0-0xCF but JPG), and SOS, DQT, DNL, DRI, DHP, EXP (0xDA-0xDF). */
const isPictureMarker = (m: number) => (m >= 0xc0 && m <= 0xcf && m !== 0xc8) || (m >= 0xda && m <= 0xdf)

/** The APPn segments that change how the picture draws: the colour profile and Adobe's colour transform. */
const JPEG_KEPT_APP: ReadonlyArray<[marker: number, id: string]> = [
  [0xe2, "ICC_PROFILE\0"],
  [0xee, "Adobe"],
]
/** JFIF's header with no thumbnail: id, version, units, density, and 0x0 thumbnail dimensions. */
const JFIF_PAYLOAD_BYTES = 14

function keepJpegSegment(marker: number, payload: Buffer): boolean {
  if (isPictureMarker(marker)) return true
  // JFIF only bare: its optional thumbnail can be an older crop of the photo.
  if (marker === 0xe0) return payload.length === JFIF_PAYLOAD_BYTES && payload.toString("latin1", 0, 5) === "JFIF\0"
  return JPEG_KEPT_APP.some(([m, id]) => m === marker && payload.toString("latin1", 0, id.length) === id)
}

function stripJpeg(b: Buffer): Uint8Array | null {
  const w = writer(b)
  w.keep(0, 2)
  let i = 2
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]
    if (marker === 0xff) {
      i++ // fill byte
      continue
    }
    // The end of the picture. Anything after it — a second image, its own EXIF — is not kept.
    if (marker === 0xd9) {
      w.keep(i, i + 2)
      return w.done()
    }
    // No length follows these; outside a scan they mean the file is not what it says.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || i + 4 > b.length) return null
    const end = i + 2 + b.readUInt16BE(i + 2)
    if (end > b.length) return null
    if (keepJpegSegment(marker, b.subarray(i + 4, end))) w.keep(i, end)
    i = end
    if (marker === 0xda) {
      // A scan's data runs to the next marker: an 0xFF that is not a stuffed 0x00 or a restart.
      let j = i
      while (j + 1 < b.length && !(b[j] === 0xff && b[j + 1] !== 0 && (b[j + 1] < 0xd0 || b[j + 1] > 0xd7))) j++
      w.keep(i, j)
      i = j
    }
  }
  return null // never reached its end: cut off
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** The picture, its palette and transparency, and how its colours are meant. Not eXIf, tEXt, zTXt, iTXt (XMP), tIME, or an animation. */
const PNG_KEPT = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "cICP"])

function stripPng(b: Buffer): Uint8Array | null {
  const w = writer(b)
  w.keep(0, 8)
  let i = 8
  while (i + 12 <= b.length) {
    const end = i + 12 + b.readUInt32BE(i) // length, type, data, CRC
    if (end > b.length) return null
    const type = b.toString("latin1", i + 4, i + 8)
    if (PNG_KEPT.has(type)) w.keep(i, end)
    if (type === "IEND") return w.done()
    i = end
  }
  return null
}

/** The picture and its alpha and colour profile. Not EXIF, not XMP, and not an animation: R9 takes stills only. */
const WEBP_KEPT = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ICCP"])
const WEBP_REFUSED = new Set(["ANIM", "ANMF"])
const VP8X_EXIF_AND_XMP = 0b1100

function stripWebp(b: Buffer): Uint8Array | null {
  const riffEnd = 8 + b.readUInt32LE(4)
  if (riffEnd > b.length) return null
  const w = writer(b)
  w.keep(0, 12) // RIFF, a size rewritten below, WEBP
  let i = 12
  while (i + 8 <= riffEnd) {
    const type = b.toString("latin1", i, i + 4)
    const size = b.readUInt32LE(i + 4)
    const end = i + 8 + size + (size % 2) // chunks are padded to an even length
    if (end > riffEnd || WEBP_REFUSED.has(type)) return null
    if (WEBP_KEPT.has(type)) {
      const at = w.at()
      w.keep(i, end)
      if (type === "VP8X") w.out[at + 8] &= ~VP8X_EXIF_AND_XMP
    }
    i = end
  }
  if (i !== riffEnd || w.at() === 12) return null
  w.out.writeUInt32LE(w.at() - 8, 4)
  return w.done()
}
