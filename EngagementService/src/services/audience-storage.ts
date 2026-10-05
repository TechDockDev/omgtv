import { randomUUID } from "node:crypto";
import { Storage, type StorageOptions } from "@google-cloud/storage";
import { loadConfig } from "../config";
import { AudienceError } from "./audience-errors";

function storageOptions(): StorageOptions {
  const keyJson = loadConfig().AUDIENCE_GCS_KEY_JSON;
  if (!keyJson) return {}; // falls back to Application Default Credentials
  try {
    const credentials = JSON.parse(keyJson);
    // Passing credentials explicitly lets the client sign v4 URLs locally
    // with this key's private key, instead of calling the IAM signBlob API
    // (which would need roles/iam.serviceAccountTokenCreator on itself).
    return { credentials, projectId: credentials.project_id };
  } catch {
    throw new Error("AUDIENCE_GCS_KEY_JSON is not valid JSON");
  }
}

export interface AudienceFileStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
  signedReadUrl(key: string, ttlSeconds: number): Promise<string>;
  /**
   * Permanent public URL for a stored file. Valid only because the bucket is
   * public-read (deliberately — see AUDIENCE_BUCKET history: switched from
   * private+signed-URLs so links can live permanently in the admin Sheet
   * export). Anyone with this URL can view the file, no auth, forever.
   */
  publicUrl(key: string): string;
}

// Keys are random and carry no user data (no names, no mobiles).
export function newStorageKey(ext: string): string {
  const d = new Date();
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return `audience/${month}/${randomUUID()}.${ext}`;
}

class GcsAudienceStorage implements AudienceFileStorage {
  private readonly bucket;
  private readonly bucketName: string;

  constructor(bucketName: string) {
    this.bucketName = bucketName;
    this.bucket = new Storage(storageOptions()).bucket(bucketName);
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.bucket.file(key).save(body, {
      contentType,
      resumable: false,
      // Bucket is public-read; long cache is fine since keys are random and
      // never reused (a replaced file gets a brand-new key, not overwritten).
      metadata: { cacheControl: "public, max-age=31536000, immutable" },
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

  publicUrl(key: string): string {
    return `https://storage.googleapis.com/${this.bucketName}/${key}`;
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
