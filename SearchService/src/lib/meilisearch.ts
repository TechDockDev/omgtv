import { MeiliSearch, Index } from "meilisearch";
import { loadConfig } from "../config";

let client: MeiliSearch | null = null;

export function getClient(): MeiliSearch {
    if (client) return client;
    const config = loadConfig();
    client = new MeiliSearch({
        host: config.MEILI_HOST,
        apiKey: config.MEILI_MASTER_KEY,
    });
    return client;
}

export const SERIES_INDEX = "series";

export async function initMeilisearch() {
    const meili = getClient();
    console.log("Initializing Meilisearch connection...");

    // Create or update index
    let index: Index;
    try {
        index = await meili.getIndex(SERIES_INDEX);
    } catch (e: any) {
        if (e.code === "index_not_found") {
            console.log(`Index '${SERIES_INDEX}' not found, creating...`);
            const task = await meili.createIndex(SERIES_INDEX, { primaryKey: "id" });
            await (meili as any).waitForTask(task.taskUid);
            index = await meili.getIndex(SERIES_INDEX);
        } else {
            throw e;
        }
    }

    // Update settings (Settings are idempotent)
    console.log("Updating index settings...");
    await index.updateSettings({
        searchableAttributes: [
            "title",
            "category",
            "tags",
            "synopsis",
        ],
        filterableAttributes: [
            "genre",
            "language",
            "releaseYear",
            "category",
        ],
        // Tweak to ensure typo tolerance is on (default)
        typoTolerance: {
            enabled: true,
        }
    });

    console.log("Meilisearch initialized successfully.");
}
