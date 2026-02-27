import { Series, Category } from "@prisma/client";
import { loadConfig } from "../config";

export type SearchPayload = {
    id: string;
    title: string;
    synopsis?: string;
    tags?: string[];
    category?: string;
    releaseYear?: number;
    language?: string; // If we add language to Series later
};

export async function syncSeriesToSearch(action: "upsert" | "delete", series: Series & { category?: Category | null }) {
    const config = loadConfig();
    const searchUrl = config.SEARCH_SERVICE_URL;

    if (!searchUrl) {
        console.warn("SEARCH_SERVICE_URL not configured, skipping search sync");
        return;
    }

    try {
        let effectiveAction = action;
        // Rule: Only PUBLISHED and PUBLIC series should be in search index
        if (action === "upsert") {
            if (series.status !== "PUBLISHED" || series.visibility !== "PUBLIC") {
                effectiveAction = "delete";
            }
        }

        const payload = effectiveAction === "delete" ? { id: series.id } : {
            id: series.id,
            title: series.title,
            slug: series.slug,
            synopsis: series.synopsis ?? undefined,
            tags: series.tags,
            category: series.category?.name,
            releaseYear: series.releaseDate ? new Date(series.releaseDate).getFullYear() : undefined,
            heroImageUrl: series.heroImageUrl,
            thumbnail: series.heroImageUrl, // Fallback/Alias as expected by Search Proxy
            status: series.status,
            visibility: series.visibility,
            publishedAt: series.releaseDate,
            createdAt: series.createdAt,
            updatedAt: series.updatedAt,
            // Add Structure Placeholders to match Home API expectations
            playback: { status: "READY", variants: [] }, // Approximate
            localization: { captions: [], availableLanguages: [] },
            personalization: { reason: "search" },
            ratings: { average: null },
            is_audio_series: series.isAudioSeries,
        };

        const body = {
            action: effectiveAction,
            payload,
        };

        // Fire and forget (or await if strict, user plan said "soft fail")
        const response = await fetch(`${searchUrl}/internal/sync`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(config.SERVICE_AUTH_TOKEN ? { "Authorization": `Bearer ${config.SERVICE_AUTH_TOKEN}` } : {}),
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            console.error(`Search sync failed: ${response.status} ${response.statusText}`);
        }
    } catch (error) {
        console.error("Search sync error:", error);
    }
}

export async function syncReelToSearch(action: "upsert" | "delete", reel: any) {
    const config = loadConfig();
    const searchUrl = config.SEARCH_SERVICE_URL;

    if (!searchUrl) return;

    try {
        let effectiveAction = action;
        // Reels are only in search if PUBLISHED and PUBLIC
        if (action === "upsert") {
            if (reel.status !== "PUBLISHED" || reel.visibility !== "PUBLIC") {
                effectiveAction = "delete";
            }
        }

        const body = {
            action: effectiveAction,
            payload: effectiveAction === "delete" ? { id: reel.id } : {
                id: reel.id,
                title: reel.title,
                description: reel.description,
                tags: reel.tags,
                category: reel.category?.name,
                status: reel.status,
                visibility: reel.visibility,
                type: "reel",
                // Add other fields as needed by search service
            }
        };

        await fetch(`${searchUrl}/internal/sync`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(config.SERVICE_AUTH_TOKEN ? { "Authorization": `Bearer ${config.SERVICE_AUTH_TOKEN}` } : {}),
            },
            body: JSON.stringify(body),
        });
    } catch (err) {
        console.error("Reel Search Sync Error:", err);
    }
}
