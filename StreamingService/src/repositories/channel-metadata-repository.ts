import { Firestore, type CollectionReference } from "@google-cloud/firestore";
import { Pool, type QueryResultRow } from "pg";
import pino, { type Logger } from "pino";
import type { Env } from "../config";
import type { ChannelMetadata } from "../types/channel";

export interface ChannelMetadataRepository {
  findByContentId(contentId: string): Promise<ChannelMetadata | null>;
  upsert(record: ChannelMetadata): Promise<void>;
  deleteByContentId(contentId: string): Promise<void>;
  listFailed(limit?: number): Promise<ChannelMetadata[]>;
}

export function createChannelMetadataRepository(
  config: Env,
  logger?: Logger
): ChannelMetadataRepository {
  const scopedLogger = logger ?? pino({ name: "channel-repo" });

  if (config.CHANNEL_REPOSITORY_BACKEND === "firestore") {
    if (!config.FIRESTORE_PROJECT_ID) {
      throw new Error("FIRESTORE_PROJECT_ID is required for firestore backend");
    }
    return new FirestoreChannelMetadataRepository(
      config.FIRESTORE_PROJECT_ID,
      scopedLogger
    );
  }

  if (config.CHANNEL_REPOSITORY_BACKEND === "postgres") {
    if (!config.POSTGRES_DSN) {
      throw new Error("POSTGRES_DSN is required for postgres backend");
    }
    return new PostgresChannelMetadataRepository(
      config.POSTGRES_DSN,
      scopedLogger
    );
  }

  return new InMemoryChannelMetadataRepository(scopedLogger);
}

class FirestoreChannelMetadataRepository implements ChannelMetadataRepository {
  private readonly collection: CollectionReference<ChannelMetadata>;
  private readonly logger: Logger;

  constructor(projectId: string, logger: Logger) {
    const firestore = new Firestore({ projectId });
    this.collection = firestore.collection(
      "omeChannels"
    ) as CollectionReference<ChannelMetadata>;
    this.logger = logger.child({ store: "firestore" });
  }

  async findByContentId(contentId: string): Promise<ChannelMetadata | null> {
    const snapshot = await this.collection.doc(contentId).get();
    if (!snapshot.exists) {
      return null;
    }
    return snapshot.data() ?? null;
  }

  async upsert(record: ChannelMetadata): Promise<void> {
    await this.collection.doc(record.contentId).set(record, { merge: true });
    this.logger.debug(
      { contentId: record.contentId },
      "Persisted channel metadata"
    );
  }

  async deleteByContentId(contentId: string): Promise<void> {
    await this.collection.doc(contentId).delete();
  }

  async listFailed(limit = 20): Promise<ChannelMetadata[]> {
    const snapshot = await this.collection
      .where("status", "==", "failed")
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) => doc.data());
  }
}

class PostgresChannelMetadataRepository implements ChannelMetadataRepository {
  private readonly pool: Pool;
  private readonly logger: Logger;
  private readonly ready: Promise<void>;

  constructor(connectionString: string, logger: Logger) {
    this.pool = new Pool({ connectionString });
    this.logger = logger.child({ store: "postgres" });
    this.ready = this.pool
      .query(
        `
        CREATE TABLE IF NOT EXISTS stream_channels (
          content_id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          classification TEXT NOT NULL,
          tenant_id TEXT,
          ready_at TIMESTAMPTZ,
          manifest_path TEXT NOT NULL,
          playback_url TEXT NOT NULL,
          origin_endpoint TEXT NOT NULL,
          cache_key TEXT NOT NULL,
          checksum TEXT NOT NULL,
          status TEXT NOT NULL,
          retries INT NOT NULL,
          source_asset_uri TEXT NOT NULL,
          last_provisioned_at TIMESTAMPTZ NOT NULL,
          ome_application TEXT,
          protocol TEXT,
          drm_key_id TEXT,
          drm_license_server TEXT,
          ingest_region TEXT,
          gcs_bucket TEXT,
          storage_prefix TEXT,
          renditions JSONB,
          availability_starts_at TIMESTAMPTZ,
          availability_ends_at TIMESTAMPTZ,
          geo_allow TEXT[],
          geo_deny TEXT[]
        )
      `
      )
      .then(() =>
        this.pool.query(
          `
        ALTER TABLE stream_channels
          ADD COLUMN IF NOT EXISTS tenant_id TEXT,
          ADD COLUMN IF NOT EXISTS ready_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS ome_application TEXT,
          ADD COLUMN IF NOT EXISTS protocol TEXT,
          ADD COLUMN IF NOT EXISTS gcs_bucket TEXT,
          ADD COLUMN IF NOT EXISTS storage_prefix TEXT,
          ADD COLUMN IF NOT EXISTS renditions JSONB
      `
        )
      )
      .then(() => undefined);
  }

  private async ensureReady() {
    await this.ready;
  }

  async findByContentId(contentId: string): Promise<ChannelMetadata | null> {
    await this.ensureReady();
    const result = await this.pool.query(
      "SELECT * FROM stream_channels WHERE content_id = $1",
      [contentId]
    );
    if (result.rowCount === 0) {
      return null;
    }
    return this.fromRow(result.rows[0]);
  }

  async upsert(record: ChannelMetadata): Promise<void> {
    await this.ensureReady();
    await this.pool.query(
      `INSERT INTO stream_channels (
          content_id, channel_id, classification, tenant_id, ready_at, manifest_path, playback_url, origin_endpoint,
          cache_key, checksum, status, retries, source_asset_uri, last_provisioned_at,
          ome_application, protocol, drm_key_id, drm_license_server, ingest_region,
          gcs_bucket, storage_prefix, renditions,
          availability_starts_at, availability_ends_at,
          geo_allow, geo_deny
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26
        )
        ON CONFLICT (content_id) DO UPDATE SET
          channel_id = EXCLUDED.channel_id,
          classification = EXCLUDED.classification,
          tenant_id = EXCLUDED.tenant_id,
          ready_at = EXCLUDED.ready_at,
          manifest_path = EXCLUDED.manifest_path,
          playback_url = EXCLUDED.playback_url,
          origin_endpoint = EXCLUDED.origin_endpoint,
          cache_key = EXCLUDED.cache_key,
          checksum = EXCLUDED.checksum,
          status = EXCLUDED.status,
          retries = EXCLUDED.retries,
          source_asset_uri = EXCLUDED.source_asset_uri,
          last_provisioned_at = EXCLUDED.last_provisioned_at,
          ome_application = EXCLUDED.ome_application,
          protocol = EXCLUDED.protocol,
          drm_key_id = EXCLUDED.drm_key_id,
          drm_license_server = EXCLUDED.drm_license_server,
          ingest_region = EXCLUDED.ingest_region,
          gcs_bucket = EXCLUDED.gcs_bucket,
          storage_prefix = EXCLUDED.storage_prefix,
          renditions = EXCLUDED.renditions,
          availability_starts_at = EXCLUDED.availability_starts_at,
          availability_ends_at = EXCLUDED.availability_ends_at,
          geo_allow = EXCLUDED.geo_allow,
          geo_deny = EXCLUDED.geo_deny
      `,
      [
        record.contentId,
        record.channelId,
        record.classification,
        record.tenantId ?? null,
        record.readyAt ?? null,
        record.manifestPath,
        record.playbackUrl,
        record.originEndpoint,
        record.cacheKey,
        record.checksum,
        record.status,
        record.retries,
        record.sourceAssetUri,
        record.lastProvisionedAt,
        record.omeApplication,
        record.protocol,
        record.drm?.keyId ?? null,
        record.drm?.licenseServer ?? null,
        record.ingestRegion ?? null,
        record.gcsBucket ?? null,
        record.storagePrefix ?? null,
        record.renditions ? JSON.stringify(record.renditions) : null,
        record.availabilityWindow?.startsAt ?? null,
        record.availabilityWindow?.endsAt ?? null,
        record.geoRestrictions?.allow ?? null,
        record.geoRestrictions?.deny ?? null,
      ]
    );
    this.logger.debug(
      { contentId: record.contentId },
      "Persisted channel metadata"
    );
  }

  async deleteByContentId(contentId: string): Promise<void> {
    await this.ensureReady();
    await this.pool.query("DELETE FROM stream_channels WHERE content_id = $1", [
      contentId,
    ]);
  }

  async listFailed(limit = 20): Promise<ChannelMetadata[]> {
    await this.ensureReady();
    const result = await this.pool.query(
      `SELECT * FROM stream_channels WHERE status = 'failed' ORDER BY last_provisioned_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => this.fromRow(row));
  }

  private fromRow(row: QueryResultRow): ChannelMetadata {
    const renditions = row.renditions
      ? typeof row.renditions === "string"
        ? JSON.parse(row.renditions)
        : row.renditions
      : undefined;

    return {
      contentId: row.content_id,
      channelId: row.channel_id,
      classification: row.classification,
      tenantId: row.tenant_id ?? undefined,
      readyAt: row.ready_at?.toISOString?.() ?? row.ready_at ?? undefined,
      manifestPath: row.manifest_path,
      playbackUrl: row.playback_url,
      originEndpoint: row.origin_endpoint,
      cacheKey: row.cache_key,
      checksum: row.checksum,
      status: row.status,
      retries: row.retries,
      sourceAssetUri: row.source_asset_uri,
      lastProvisionedAt:
        row.last_provisioned_at.toISOString?.() ?? row.last_provisioned_at,
      omeApplication:
        row.ome_application ??
        (row.classification === "reel" ? "reels" : "series"),
      protocol:
        row.protocol ?? (row.classification === "reel" ? "ll-hls" : "hls"),
      gcsBucket: row.gcs_bucket ?? undefined,
      storagePrefix: row.storage_prefix ?? undefined,
      renditions,
      drm:
        row.drm_key_id && row.drm_license_server
          ? { keyId: row.drm_key_id, licenseServer: row.drm_license_server }
          : undefined,
      ingestRegion: row.ingest_region ?? undefined,
      availabilityWindow:
        row.availability_starts_at && row.availability_ends_at
          ? {
              startsAt:
                row.availability_starts_at.toISOString?.() ??
                row.availability_starts_at,
              endsAt:
                row.availability_ends_at.toISOString?.() ??
                row.availability_ends_at,
            }
          : undefined,
      geoRestrictions:
        row.geo_allow || row.geo_deny
          ? {
              allow: row.geo_allow ?? undefined,
              deny: row.geo_deny ?? undefined,
            }
          : undefined,
    };
  }
}

class InMemoryChannelMetadataRepository implements ChannelMetadataRepository {
  private readonly store = new Map<string, ChannelMetadata>();
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ store: "memory" });
  }

  async findByContentId(contentId: string): Promise<ChannelMetadata | null> {
    return this.store.get(contentId) ?? null;
  }

  async upsert(record: ChannelMetadata): Promise<void> {
    this.store.set(record.contentId, record);
    this.logger.debug(
      { contentId: record.contentId },
      "Persisted channel metadata"
    );
  }

  async deleteByContentId(contentId: string): Promise<void> {
    this.store.delete(contentId);
  }

  async listFailed(limit = 20): Promise<ChannelMetadata[]> {
    const failed = Array.from(this.store.values()).filter(
      (record) => record.status === "failed"
    );
    return failed.slice(0, limit);
  }
}
