import assert from "node:assert/strict";
import { serializerCompiler } from "fastify-type-provider-zod";
import { userContentStatsResponseSchema } from "../schemas/admin-analytics";

const serialize = serializerCompiler({
    schema: userContentStatsResponseSchema,
    method: "GET",
    url: "/internal/analytics/users/:userId/content",
    httpStatus: "200",
    contentType: "application/json",
} as never);

const payload = {
    watchHistory: [
        {
            episodeId: "episode-1",
            title: "Episode 1",
            thumbnailUrl: "https://cdn.omgtv.in/thumb.jpg",
            manifestUrl: "https://cdn.omgtv.in/manifest.m3u8",
            progressSeconds: 120,
            durationSeconds: 180,
            isCompleted: false,
            lastWatchedAt: "2026-03-16T10:00:00.000Z",
        },
    ],
    likes: {
        reels: [],
        series: [],
        episodes: [
            {
                id: "episode-1",
                title: "Episode 1",
                thumbnailUrl: "https://cdn.omgtv.in/thumb.jpg",
                manifestUrl: "https://cdn.omgtv.in/manifest.m3u8",
            },
        ],
    },
    saves: {
        reels: [],
        series: [],
        episodes: [
            {
                id: "episode-2",
                title: "Episode 2",
                thumbnailUrl: null,
                manifestUrl: null,
            },
        ],
    },
    ongoingSeries: [],
    completedSeries: [],
    stats: {
        totalWatchTimeSeconds: 120,
        episodesStarted: 1,
        episodesCompleted: 0,
        totalLikes: 1,
        totalSaves: 1,
    },
    pagination: {
        limit: 50,
        offset: 0,
        totalHistory: 1,
        totalLikes: 1,
        totalSaves: 1,
    },
};

const serialized = serialize(payload);
const parsed = JSON.parse(serialized);

assert.deepEqual(Object.keys(parsed.likes).sort(), ["episodes", "reels", "series"]);
assert.deepEqual(Object.keys(parsed.saves).sort(), ["episodes", "reels", "series"]);
assert.equal(parsed.likes.episodes[0]?.id, "episode-1");
assert.equal(parsed.saves.episodes[0]?.id, "episode-2");

const invalid = userContentStatsResponseSchema.safeParse({
    ...payload,
    likes: {
        reels: [],
        series: [],
    },
});

assert.equal(invalid.success, false);

console.log("admin analytics schema test passed");
