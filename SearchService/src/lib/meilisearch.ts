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
    console.log("Starting Meilisearch initialization loop...");

    // We run this in the background so we don't block the server startup
    // The server will be up (serving 404s for search) until this succeeds.
    runRetryLoop();
}

async function runRetryLoop() {
    const meili = getClient();
    let connected = false;

    while (!connected) {
        try {
            console.log("Attempting to connect to Meilisearch...");
            // Check health first
            await meili.health();
            console.log("Meilisearch is healthy!");

            // Create or update index
            let index: Index;
            try {
                index = await meili.getIndex(SERIES_INDEX);
            } catch (e: any) {
                // Check code OR message to be safe (Meilisearch errors can vary by version/transport)
                if (e.code === "index_not_found" || e.message?.includes("not found")) {
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
            connected = true;

        } catch (err: any) {
            console.warn(`Meilisearch connection failed: ${err.message}. Retrying in 5s...`);
            // Wait 5 seconds before retrying (Memory safe, no recursion)
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}
