import { z } from "zod";
import { createSuccessResponseSchema } from "./base.schema";
import type { SuccessResponse } from "../utils/envelope";

const assetTypeEnum = z.enum(["video", "thumbnail", "banner"]);

export const createUploadUrlBodySchema = z.object({
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(3).max(128),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(512 * 1024 * 1024),
  assetType: assetTypeEnum,
  contentId: z.string().uuid().optional(),
  contentClassification: z.enum(["REEL", "EPISODE"]).optional(),
});

export const createUploadUrlResponseSchema = z.object({
  uploadId: z.string().uuid(),
  uploadUrl: z.string().url(),
  expiresAt: z.string().datetime(),
  objectKey: z.string().min(1),
  storageUrl: z.string().regex(/^gs:\/\//, "storageUrl must be a gs:// URI"),
  fields: z.record(z.string(), z.string()),
  cdn: z.string().url().optional(),
});

export const createUploadUrlSuccessResponseSchema = createSuccessResponseSchema(
  createUploadUrlResponseSchema
);

export const uploadStatusResponseSchema = z.object({
  uploadId: z.string().uuid(),
  status: z.enum([
    "REQUESTED",
    "UPLOADING",
    "VALIDATING",
    "PROCESSING",
    "READY",
    "FAILED",
    "EXPIRED",
  ]),
  assetType: assetTypeEnum,
  objectKey: z.string(),
  storageUrl: z.string().url().optional(),
  cdnUrl: z.string().url().optional(),
  sizeBytes: z.number().int().nonnegative(),
  contentType: z.string(),
  expiresAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  failureReason: z.string().optional(),
  validationMeta: z
    .object({
      durationSeconds: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      checksum: z.string().optional(),
      bitrateKbps: z.number().int().positive().optional(),
    })
    .optional(),
  processingMeta: z
    .object({
      manifestUrl: z.string().url().optional(),
      defaultThumbnailUrl: z.string().url().optional(),
      previewGeneratedAt: z.string().datetime().optional(),
    })
    .optional(),
});

export const uploadStatusSuccessResponseSchema = createSuccessResponseSchema(
  uploadStatusResponseSchema
);

export const uploadQuotaResponseSchema = z.object({
  concurrentLimit: z.number().int().positive(),
  dailyLimit: z.number().int().positive(),
  activeUploads: z.number().int().nonnegative(),
  dailyUploads: z.number().int().nonnegative(),
});

export const uploadQuotaSuccessResponseSchema = createSuccessResponseSchema(
  uploadQuotaResponseSchema
);

export const retryUploadResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  uploadId: z.string().uuid(),
});

export type RetryUploadResponse = z.infer<typeof retryUploadResponseSchema>;
export type RetryUploadSuccessResponse = SuccessResponse<RetryUploadResponse>;
export const retryUploadSuccessResponseSchema = createSuccessResponseSchema(
  retryUploadResponseSchema
);

// Exports
export type CreateUploadUrlBody = z.infer<typeof createUploadUrlBodySchema>;
export type CreateUploadUrlResponse = z.infer<
  typeof createUploadUrlResponseSchema
>;
export type UploadStatusResponse = z.infer<typeof uploadStatusResponseSchema>;
export type UploadQuotaResponse = z.infer<typeof uploadQuotaResponseSchema>;
export type CreateUploadUrlSuccessResponse =
  SuccessResponse<CreateUploadUrlResponse>;
export type UploadStatusSuccessResponse = SuccessResponse<UploadStatusResponse>;
export type UploadQuotaSuccessResponse = SuccessResponse<UploadQuotaResponse>;

