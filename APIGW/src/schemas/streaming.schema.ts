import { z } from "zod";
import { createSuccessResponseSchema } from "./base.schema";
import type { SuccessResponse } from "../utils/envelope";

const drmSchema = z.object({
  keyId: z.string(),
  licenseServer: z.string().url(),
});

const windowSchema = z.object({
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});

export const manifestParamsSchema = z.object({
  contentId: z.string().uuid(),
});

export const manifestQuerySchema = z.object({
  quality: z.enum(["auto", "1080p", "720p", "480p", "360p"]).optional(),
  device: z.enum(["mobile", "tablet", "web", "tv"]).optional(),
  geo: z.string().length(2).optional(),
  session: z.string().uuid().optional(),
});

export const manifestResponseSchema = z.object({
  manifestUrl: z.string().url(),
  expiresAt: z.string().datetime(),
  cdn: z.string(),
  drm: drmSchema.optional(),
  entitlements: z.array(z.string()),
  policy: z.object({
    cacheControl: z.string(),
    ttlSeconds: z.number().int().positive(),
    failover: z.boolean(),
  }),
  availability: windowSchema.optional(),
});

export const manifestSuccessResponseSchema = createSuccessResponseSchema(
  manifestResponseSchema
);

export const streamMetadataSchema = z.object({
  contentId: z.string().uuid(),
  channelId: z.string(),
  classification: z.enum(["reel", "series"]),
  manifestPath: z.string(),
  playbackUrl: z.string().url(),
  originEndpoint: z.string(),
  cacheKey: z.string(),
  checksum: z.string(),
  status: z.enum(["provisioning", "ready", "failed", "retired"]),
  retries: z.number().int().nonnegative(),
  sourceAssetUri: z.string(),
  lastProvisionedAt: z.string().datetime(),
  drm: drmSchema.optional(),
  ingestRegion: z.string().optional(),
  availabilityWindow: windowSchema.optional(),
  geoRestrictions: z
    .object({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
});

export const registerStreamRequestSchema = z.object({
  contentId: z.string().uuid(),
  tenantId: z.string().min(1),
  contentType: z.enum(["reel", "series"]),
  sourceGcsUri: z.string(),
  checksum: z.string(),
  durationSeconds: z.number().int().positive(),
  ingestRegion: z.string(),
  drm: drmSchema.optional(),
  availabilityWindow: windowSchema.optional(),
  geoRestrictions: z
    .object({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
});

export const registerStreamResponseSchema =
  createSuccessResponseSchema(streamMetadataSchema);

export const channelMetadataResponseSchema =
  createSuccessResponseSchema(streamMetadataSchema);

export type ManifestParams = z.infer<typeof manifestParamsSchema>;
export type ManifestQuery = z.infer<typeof manifestQuerySchema>;
export type ManifestResponse = z.infer<typeof manifestResponseSchema>;
export type ManifestSuccessResponse = SuccessResponse<ManifestResponse>;
export type RegisterStreamRequest = z.infer<typeof registerStreamRequestSchema>;
export type StreamMetadataResponse = SuccessResponse<
  z.infer<typeof streamMetadataSchema>
>;
