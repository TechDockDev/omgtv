export type SniffedFile =
  | { kind: "image"; mime: "image/jpeg" | "image/png" | "image/webp"; ext: "jpg" | "png" | "webp" }
  | { kind: "pdf"; mime: "application/pdf"; ext: "pdf" };

// Identify a file by its leading bytes. The client-supplied filename and
// Content-Type are never trusted.
export function sniffFile(buf: Buffer): SniffedFile | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { kind: "image", mime: "image/jpeg", ext: "jpg" };
  }
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { kind: "image", mime: "image/png", ext: "png" };
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { kind: "image", mime: "image/webp", ext: "webp" };
  }
  if (buf.length >= 5 && buf.toString("ascii", 0, 5) === "%PDF-") {
    return { kind: "pdf", mime: "application/pdf", ext: "pdf" };
  }
  return null;
}
