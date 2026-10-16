/*
 * A stored photo carries no location (SCRUM-626).
 *
 * Found by code reading: nothing in lib/ stripped EXIF, and a seal copied the
 * uploaded bytes as they were, so a phone photo's GPS position was stored and
 * served to whoever saw the message. The fixtures are real photos
 * (`support/gps-photos.ts`); the stripped copies were decoded by Pillow, pixel
 * for pixel the same, with no EXIF.
 *
 * Each format is pinned both ways: what says where it was taken is gone, and
 * what draws the picture is still there byte for byte, so a strip that threw
 * the picture away fails too.
 */
import { stripImageMetadata } from "@/lib/image-metadata"
import { ANIMATED_WEBP, bytesOf, has, JPEG_WITH_GPS, METADATA, PNG_WITH_GPS, WEBP_WITH_GPS } from "./support/gps-photos"

const buf = (b64: string) => Buffer.from(b64, "base64")
const strip = (b: Uint8Array) => {
  const out = stripImageMetadata(b)
  if (!out) throw new Error("refused")
  return Buffer.from(out.bytes)
}

/** A JPEG's segments up to its first scan: marker and the whole segment. */
function jpegHeaderSegments(b: Buffer) {
  const segments: Array<{ marker: number; bytes: Buffer }> = []
  for (let i = 2; b[i + 1] !== 0xda; ) {
    const end = i + 2 + b.readUInt16BE(i + 2)
    segments.push({ marker: b[i + 1], bytes: b.subarray(i, end) })
    i = end
  }
  return segments
}

/** A PNG's or a WebP's chunks: type and the whole chunk. */
function pngChunks(b: Buffer) {
  const chunks: Array<{ type: string; bytes: Buffer }> = []
  for (let i = 8; i < b.length; ) {
    const end = i + 12 + b.readUInt32BE(i)
    chunks.push({ type: b.toString("latin1", i + 4, i + 8), bytes: b.subarray(i, end) })
    i = end
  }
  return chunks
}
function webpChunks(b: Buffer) {
  const chunks: Array<{ type: string; bytes: Buffer }> = []
  for (let i = 12; i < b.length; ) {
    const size = b.readUInt32LE(i + 4)
    const end = i + 8 + size + (size % 2)
    chunks.push({ type: b.toString("latin1", i, i + 4), bytes: b.subarray(i, end) })
    i = end
  }
  return chunks
}

/** A JPEG segment: marker, length, payload. */
const segment = (marker: number, payload: Buffer) =>
  Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload])
/** The fixture with extra segments right after its SOI. */
const jpegWith = (...extra: Buffer[]) => {
  const b = buf(JPEG_WITH_GPS)
  return Buffer.concat([b.subarray(0, 2), ...extra, b.subarray(2)])
}

describe("stripping a photo's metadata", () => {
  it.each([
    ["JPEG", JPEG_WITH_GPS, "image/jpeg"],
    ["PNG", PNG_WITH_GPS, "image/png"],
    ["WebP", WEBP_WITH_GPS, "image/webp"],
  ])("drops a %s's GPS block, EXIF, XMP, text and comments", (_label, b64, contentType) => {
    const original = bytesOf(b64)
    // The fixture really does carry it: otherwise the assertions below prove nothing.
    expect(METADATA.filter((m) => has(original, m)).length).toBeGreaterThanOrEqual(4)

    const stripped = stripImageMetadata(original)

    expect(stripped?.contentType).toBe(contentType)
    expect(METADATA.filter((m) => has(stripped!.bytes, m))).toEqual([])
  })

  it("keeps every JPEG segment the picture needs byte for byte: its tables, its ICC profile, its scan with its restart markers", () => {
    const original = buf(JPEG_WITH_GPS)
    const header = jpegHeaderSegments(original)
    const dropped = header.filter((s) => s.marker === 0xe1 || s.marker === 0xfe)
    // Two APP1s (EXIF, XMP) and a comment.
    expect(dropped.map((s) => s.marker)).toEqual([0xe1, 0xe1, 0xfe])
    expect(header.map((s) => s.marker)).toEqual(expect.arrayContaining([0xe0, 0xe2]))
    const restarts = (b: Buffer) => [...b.keys()].filter((i) => b[i] === 0xff && b[i + 1] >= 0xd0 && b[i + 1] <= 0xd7).length
    expect(restarts(original)).toBeGreaterThan(0)

    const expected = Buffer.concat([
      original.subarray(0, 2),
      ...header.filter((s) => !dropped.includes(s)).map((s) => s.bytes),
      original.subarray(2 + header.reduce((n, s) => n + s.bytes.length, 0)),
    ])
    expect(strip(original)).toEqual(expected)
  })

  it("keeps Adobe's colour transform, and drops a JFIF header that carries a thumbnail (an older crop) and any reserved marker", () => {
    const adobe = segment(0xee, Buffer.from("Adobe\0\x64\0\0\0\0\x01", "latin1"))
    const thumbnail = segment(0xe0, Buffer.concat([Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\x01\x01", "latin1"), Buffer.from([1, 2, 3])]))
    const reserved = segment(0xf0, Buffer.from("GPS 12,58N", "latin1"))
    const stripped = strip(jpegWith(adobe, thumbnail, reserved))
    expect(stripped.includes(adobe)).toBe(true)
    expect(stripped.includes(thumbnail)).toBe(false)
    expect(has(stripped, "GPS 12,58N")).toBe(false)
  })

  it("keeps a PNG's picture chunks byte for byte and drops eXIf, tEXt, zTXt and iTXt", () => {
    const original = buf(PNG_WITH_GPS)
    const chunks = pngChunks(original)
    const metadata = ["eXIf", "tEXt", "zTXt", "iTXt"]
    expect(chunks.map((c) => c.type)).toEqual(expect.arrayContaining([...metadata, "IHDR", "IDAT", "IEND"]))
    const expected = Buffer.concat([original.subarray(0, 8), ...chunks.filter((c) => !metadata.includes(c.type)).map((c) => c.bytes)])
    expect(strip(original)).toEqual(expected)
  })

  it("keeps a WebP's picture, alpha and colour profile byte for byte, and its VP8X flags but EXIF and XMP", () => {
    const original = buf(WEBP_WITH_GPS)
    const before = webpChunks(original)
    expect(before.map((c) => c.type)).toEqual(expect.arrayContaining(["VP8X", "ICCP", "ALPH", "VP8 ", "EXIF", "XMP "]))
    const stripped = strip(original)
    const after = webpChunks(stripped)
    expect(after.map((c) => c.type)).toEqual(before.map((c) => c.type).filter((t) => t !== "EXIF" && t !== "XMP "))
    for (const type of ["ICCP", "ALPH", "VP8 "]) {
      expect(after.find((c) => c.type === type)!.bytes).toEqual(before.find((c) => c.type === type)!.bytes)
    }
    expect(stripped.readUInt32LE(4)).toBe(stripped.length - 8)
    // Bits: 5 ICC, 4 alpha, 3 EXIF, 2 XMP. The first two are the picture's.
    const flags = (b: Buffer) => b[b.indexOf(Buffer.from("VP8X", "latin1")) + 8]
    expect(flags(original)).toBe(0b111100)
    expect(flags(stripped)).toBe(0b110000)
  })

  it.each([
    ["JPEG", JPEG_WITH_GPS],
    ["PNG", PNG_WITH_GPS],
    ["WebP", WEBP_WITH_GPS],
  ])("drops what a %s carries after its end: a second picture can hold a second EXIF block", (_label, b64) => {
    const original = buf(b64)
    const trailer = Buffer.from("\xff\xd8\xff\xe1\x00\x10Exif\0\0MM\0*GPS", "latin1")
    expect(strip(Buffer.concat([original, trailer]))).toEqual(strip(original))
  })

  it("does not change the bytes it was given", () => {
    const original = bytesOf(WEBP_WITH_GPS)
    const copy = Uint8Array.from(original)
    stripImageMetadata(original)
    expect(original).toEqual(copy)
  })

  it.each([
    ["an HTML page", Buffer.from("<html><script>alert(1)</script></html>")],
    ["a GIF", Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1")],
    ["an animated WebP: stills only (R9)", buf(ANIMATED_WEBP)],
    ["a JPEG cut off inside its tables", buf(JPEG_WITH_GPS).subarray(0, 300)],
    ["a JPEG cut off inside its picture data, with no end marker", buf(JPEG_WITH_GPS).subarray(0, -2)],
    ["a PNG cut off before its end", buf(PNG_WITH_GPS).subarray(0, 200)],
    ["a WebP whose container is longer than the file", buf(WEBP_WITH_GPS).subarray(0, 100)],
    ["nothing", Buffer.alloc(0)],
  ])("refuses %s: only a JPEG, PNG or WebP it can walk to the end is a photo", (_label, bytes) => {
    expect(stripImageMetadata(bytes)).toBeNull()
  })
})
