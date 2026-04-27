import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { MediaAssetStatus, MediaAssetType } from "@prisma/client";
import { getPrisma } from "../../lib/prisma";

// Resolve a media asset by uploadId (UploadService session string) or by its UUID id.
// Mirrors how CatalogService resolves assets for episodes — tries uploadId first, then id.
async function resolveMediaAsset(
  prisma: ReturnType<typeof getPrisma>,
  opts: { uploadId?: string; mediaAssetId?: string }
) {
  if (opts.mediaAssetId) {
    return prisma.mediaAsset.findUnique({ where: { id: opts.mediaAssetId }, include: { variants: true } });
  }
  if (opts.uploadId) {
    // Try as UploadService session string first
    const byUploadId = await prisma.mediaAsset.findUnique({ where: { uploadId: opts.uploadId }, include: { variants: true } });
    if (byUploadId) return byUploadId;
    // Fallback: treat it as the MediaAsset UUID (admin may send the id field as uploadId)
    return prisma.mediaAsset.findUnique({ where: { id: opts.uploadId }, include: { variants: true } }).catch(() => null);
  }
  return null;
}

const createTrailerSchema = z.object({
  title: z.string().min(1).optional(),
  thumbnailUrl: z.string().url().optional(),
  durationSeconds: z.number().int().nonnegative().default(0),
  uploadId: z.string().optional(),
  mediaAssetId: z.string().uuid().optional(),
  listed: z.boolean().default(true),
});

const updateTrailerSchema = createTrailerSchema.partial();

export default async function adminTrailerRoutes(fastify: FastifyInstance) {
  const prisma = getPrisma();

  const requireAdminId = (request: FastifyRequest, reply: FastifyReply): string => {
    const value = request.headers["x-admin-id"];
    if (typeof value === "string" && value.length > 0) return value;
    throw reply.server.httpErrors.badRequest("Missing x-admin-id header");
  };

  // POST /:seriesId/trailer — create
  fastify.post<{ Params: { seriesId: string } }>("/:seriesId/trailer", {
    schema: {
      params: z.object({ seriesId: z.string().uuid() }),
      body: createTrailerSchema,
    },
    handler: async (request, reply) => {
      const adminId = requireAdminId(request, reply);
      const { seriesId } = request.params as { seriesId: string };
      const body = createTrailerSchema.parse(request.body);

      const series = await prisma.series.findUnique({ where: { id: seriesId, deletedAt: null } });
      if (!series) return reply.status(404).send({ message: "Series not found" });

      const existing = await prisma.mediaAsset.findFirst({
        where: { seriesId, type: MediaAssetType.TRAILER, deletedAt: null },
      });
      if (existing) return reply.status(409).send({ message: "Trailer already exists. Edit or delete it first." });

      let trailer;

      // Same pattern as episodes — link existing MediaAsset if uploadId or mediaAssetId given
      if (body.uploadId || body.mediaAssetId) {
        const asset = await resolveMediaAsset(prisma, { uploadId: body.uploadId, mediaAssetId: body.mediaAssetId });

        if (!asset) return reply.status(404).send({ message: "Media asset not found" });

        trailer = await prisma.mediaAsset.update({
          where: { id: asset.id },
          data: {
            type: MediaAssetType.TRAILER,
            seriesId,
            title: body.title ?? asset.title,
            defaultThumbnailUrl: body.thumbnailUrl ?? asset.defaultThumbnailUrl,
            listed: body.listed,
            updatedByAdminId: adminId,
            deletedAt: null,
          },
          include: { variants: true },
        });
      } else {
        // No video yet — create placeholder, video can be linked later via edit
        trailer = await prisma.mediaAsset.create({
          data: {
            type: MediaAssetType.TRAILER,
            seriesId,
            title: body.title,
            defaultThumbnailUrl: body.thumbnailUrl,
            status: MediaAssetStatus.PENDING,
            listed: body.listed,
            createdByAdminId: adminId,
          },
          include: { variants: true },
        });
      }

      return reply.status(201).send({ success: true, data: trailer });
    },
  });

  // GET /:seriesId/trailer
  fastify.get<{ Params: { seriesId: string } }>("/:seriesId/trailer", {
    schema: { params: z.object({ seriesId: z.string().uuid() }) },
    handler: async (request, reply) => {
      const { seriesId } = request.params as { seriesId: string };
      const trailer = await prisma.mediaAsset.findFirst({
        where: { seriesId, type: MediaAssetType.TRAILER, deletedAt: null },
        include: { variants: true },
      });
      if (!trailer) return reply.status(404).send({ message: "No trailer for this series" });
      return { success: true, data: trailer };
    },
  });

  // PATCH /:seriesId/trailer — edit
  fastify.patch<{ Params: { seriesId: string } }>("/:seriesId/trailer", {
    schema: {
      params: z.object({ seriesId: z.string().uuid() }),
      body: updateTrailerSchema,
    },
    handler: async (request, reply) => {
      const adminId = requireAdminId(request, reply);
      const { seriesId } = request.params as { seriesId: string };
      const body = updateTrailerSchema.parse(request.body);

      const trailer = await prisma.mediaAsset.findFirst({
        where: { seriesId, type: MediaAssetType.TRAILER, deletedAt: null },
      });
      if (!trailer) return reply.status(404).send({ message: "No trailer for this series" });

      // If new video is being linked
      let targetId = trailer.id;
      if (body.uploadId || body.mediaAssetId) {
        const asset = await resolveMediaAsset(prisma, { uploadId: body.uploadId, mediaAssetId: body.mediaAssetId });

        if (!asset) return reply.status(404).send({ message: "Media asset not found" });

        // Unlink old placeholder if it was a different asset
        if (asset.id !== trailer.id) {
          await prisma.mediaAsset.update({
            where: { id: trailer.id },
            data: { seriesId: null, type: MediaAssetType.REEL, deletedAt: new Date() },
          });
          targetId = asset.id;
        }
      }

      const updated = await prisma.mediaAsset.update({
        where: { id: targetId },
        data: {
          type: MediaAssetType.TRAILER,
          seriesId,
          ...(body.title !== undefined && { title: body.title }),
          ...(body.thumbnailUrl !== undefined && { defaultThumbnailUrl: body.thumbnailUrl }),
          ...(body.listed !== undefined && { listed: body.listed }),
          ...(body.uploadId !== undefined && { uploadId: body.uploadId }),
          updatedByAdminId: adminId,
          deletedAt: null,
        },
        include: { variants: true },
      });

      return { success: true, data: updated };
    },
  });

  // DELETE /:seriesId/trailer
  fastify.delete<{ Params: { seriesId: string } }>("/:seriesId/trailer", {
    schema: { params: z.object({ seriesId: z.string().uuid() }) },
    handler: async (request, reply) => {
      const adminId = requireAdminId(request, reply);
      const { seriesId } = request.params as { seriesId: string };

      const trailer = await prisma.mediaAsset.findFirst({
        where: { seriesId, type: MediaAssetType.TRAILER, deletedAt: null },
      });
      if (!trailer) return reply.status(404).send({ message: "No trailer for this series" });

      await prisma.mediaAsset.update({
        where: { id: trailer.id },
        data: { deletedAt: new Date(), updatedByAdminId: adminId },
      });

      return reply.status(204).send();
    },
  });
}
