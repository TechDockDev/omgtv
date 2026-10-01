import sharp from "sharp";
import type { SniffedFile } from "./file-sniff";
import { AudienceError } from "../services/audience-errors";

const MAX_INPUT_PIXELS = 40_000_000; // decompression-bomb guard
const MAX_DIMENSION = 4096;

// Re-encode the image. sharp drops all metadata (EXIF incl. GPS, XMP, ICC
// comments) on output unless asked to keep it, and re-encoding also discards
// anything smuggled after the image data. Orientation is baked in first so
// stripping EXIF doesn't leave photos sideways.
export async function sanitizeImage(
  input: Buffer,
  sniffed: Extract<SniffedFile, { kind: "image" }>
): Promise<Buffer> {
  try {
    const pipeline = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      .rotate()
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      });

    switch (sniffed.mime) {
      case "image/jpeg":
        return await pipeline.jpeg({ quality: 85 }).toBuffer();
      case "image/png":
        return await pipeline.png().toBuffer();
      case "image/webp":
        return await pipeline.webp({ quality: 85 }).toBuffer();
    }
  } catch {
    throw new AudienceError("UNSUPPORTED_FILE", "One of the photos is corrupt or not a valid image.");
  }
}
