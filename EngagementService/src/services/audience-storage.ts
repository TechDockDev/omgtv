import { randomUUID } from "node:crypto";
import { Storage } from "@google-cloud/storage";
import { loadConfig } from "../config";
import { AudienceError } from "./audience-errors";

export interface AudienceFileStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
  signedReadUrl(key: string, ttlSeconds: number): Promise<string>;
}

// Keys are random and carry no user data (no names, no mobiles).
export function newStorageKey(ext: string): string {
  const d = new Date();
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return `audience/${month}/${randomUUID()}.${ext}`;
}

class GcsAudienceStorage implements AudienceFileStorage {
  private readonly bucket;

  constructor(bucketName: string) {
    this.bucket = new Storage().bucket(bucketName);
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.bucket.file(key).save(body, {
      contentType,
      resumable: false,
      // Private object; never served by public URL or CDN.
      metadata: { cacheControl: "private, max-age=0, no-store" },
    });
  }

  async remove(key: string): Promise<void> {
    await this.bucket.file(key).delete({ ignoreNotFound: true });
  }

  async signedReadUrl(key: string, ttlSeconds: number): Promise<string> {
    const [url] = await this.bucket.file(key).getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + ttlSeconds * 1000,
    });
    return url;
  }
}

let cached: AudienceFileStorage | null | undefined;

/** Returns null when AUDIENCE_BUCKET is not configured. */
export function getAudienceStorage(): AudienceFileStorage | null {
  if (cached !== undefined) return cached;
  const bucket = loadConfig().AUDIENCE_BUCKET;
  cached = bucket ? new GcsAudienceStorage(bucket) : null;
  return cached;
}

export function requireAudienceStorage(): AudienceFileStorage {
  const storage = getAudienceStorage();
  if (!storage) {
    throw new AudienceError(
      "SERVICE_UNAVAILABLE",
      "File uploads are temporarily unavailable. Please try again later."
    );
  }
  return storage;
}

// Test seam.
export function setAudienceStorageForTests(storage: AudienceFileStorage | null | undefined) {
  cached = storage;
}
