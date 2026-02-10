import type { PrismaClient } from "@prisma/client";

export interface UserContentStats {
    watchHistory: Array<{
        episodeId: string;
        progressSeconds: number;
        durationSeconds: number;
        isCompleted: boolean;
        lastWatchedAt: string;
    }>;
    likes: {
        reels: string[];
        series: string[];
    };
    saves: {
        reels: string[];
        series: string[];
    };
    stats: {
        totalWatchTimeSeconds: number;
        episodesStarted: number;
        episodesCompleted: number;
        totalLikes: number;
        totalSaves: number;
    };
}

export async function getUserContentStats(params: {
    prisma: PrismaClient;
    userId: string;
}): Promise<UserContentStats> {
    const { prisma, userId } = params;

    // Fetch watch history, likes, and saves in parallel
    const [watchHistory, likedActions, savedActions] = await Promise.all([
        prisma.viewProgress.findMany({
            where: { userId },
            orderBy: { updatedAt: "desc" },
            take: 100,
        }),
        prisma.userAction.findMany({
            where: { userId, actionType: "LIKE", isActive: true },
            select: { contentType: true, contentId: true },
        }),
        prisma.userAction.findMany({
            where: { userId, actionType: "SAVE", isActive: true },
            select: { contentType: true, contentId: true },
        }),
    ]);

    // Separate likes by content type
    const likedReels = likedActions
        .filter((a) => a.contentType === "REEL")
        .map((a) => a.contentId);
    const likedSeries = likedActions
        .filter((a) => a.contentType === "SERIES")
        .map((a) => a.contentId);

    // Separate saves by content type
    const savedReels = savedActions
        .filter((a) => a.contentType === "REEL")
        .map((a) => a.contentId);
    const savedSeries = savedActions
        .filter((a) => a.contentType === "SERIES")
        .map((a) => a.contentId);

    // Compute aggregate stats
    const totalWatchTimeSeconds = watchHistory.reduce(
        (sum, entry) => sum + entry.progressSeconds,
        0
    );
    const episodesCompleted = watchHistory.filter(
        (entry) => entry.completedAt !== null
    ).length;

    return {
        watchHistory: watchHistory.map((entry) => ({
            episodeId: entry.episodeId,
            progressSeconds: entry.progressSeconds,
            durationSeconds: entry.durationSeconds,
            isCompleted: entry.completedAt !== null,
            lastWatchedAt: entry.updatedAt.toISOString(),
        })),
        likes: {
            reels: likedReels,
            series: likedSeries,
        },
        saves: {
            reels: savedReels,
            series: savedSeries,
        },
        stats: {
            totalWatchTimeSeconds,
            episodesStarted: watchHistory.length,
            episodesCompleted,
            totalLikes: likedActions.length,
            totalSaves: savedActions.length,
        },
    };
}
