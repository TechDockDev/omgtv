import { z } from "zod";

export const contentDetailSchema = z.object({
    id: z.string(),
    title: z.string(),
    thumbnailUrl: z.string().nullable(),
    manifestUrl: z.string().nullable(),
});

export const userContentStatsResponseSchema = z.object({
    watchHistory: z.array(
        z.object({
            episodeId: z.string(),
            title: z.string(),
            thumbnailUrl: z.string().nullable(),
            manifestUrl: z.string().nullable(),
            progressSeconds: z.number(),
            durationSeconds: z.number(),
            isCompleted: z.boolean(),
            lastWatchedAt: z.string(),
        })
    ),
    likes: z.object({
        reels: z.array(contentDetailSchema),
        series: z.array(contentDetailSchema),
        episodes: z.array(contentDetailSchema),
    }),
    saves: z.object({
        reels: z.array(contentDetailSchema),
        series: z.array(contentDetailSchema),
        episodes: z.array(contentDetailSchema),
    }),
    ongoingSeries: z.array(z.any()),
    completedSeries: z.array(z.any()),
    stats: z.object({
        totalWatchTimeSeconds: z.number(),
        episodesStarted: z.number(),
        episodesCompleted: z.number(),
        totalLikes: z.number(),
        totalSaves: z.number(),
    }),
    pagination: z.object({
        limit: z.number(),
        offset: z.number(),
        totalHistory: z.number(),
        totalLikes: z.number(),
        totalSaves: z.number(),
    }),
});

export type UserContentStatsResponse = z.infer<typeof userContentStatsResponseSchema>;
