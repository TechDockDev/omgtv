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
        const payload = action === "delete" ? { id: series.id } : {
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
        };

        const body = {
            action,
            payload,
        };

        // Fire and forget (or await if strict, user plan said "soft fail")
        // We await it but catch error to soft fail
        const response = await fetch(`${searchUrl}/internal/sync`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                // Add service auth token if needed
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
