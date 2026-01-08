import { z } from "zod";

export const contentParamsSchema = z.object({
  id: z.string().uuid(),
});

const thumbnailSchema = z.object({
  url: z.string().url(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const contentResponseSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string().optional(),
  durationSeconds: z.number().int().nonnegative(),
  ownerId: z.string().uuid(),
  publishedAt: z.string().datetime(),
  visibility: z.enum(["public", "private", "unlisted"]).default("public"),
  tags: z.array(z.string()).default([]),
  thumbnails: z.array(thumbnailSchema).default([]),
  stats: z
    .object({
      views: z.number().int().nonnegative().default(0),
      likes: z.number().int().nonnegative().default(0),
      comments: z.number().int().nonnegative().default(0),
    })
    .default({ views: 0, likes: 0, comments: 0 }),
});

export type ContentParams = z.infer<typeof contentParamsSchema>;
export type ContentResponse = z.infer<typeof contentResponseSchema>;
