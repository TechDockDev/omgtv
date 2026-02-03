
// sync-production.js
// Native fetch (Node 18+)

const CONTENT_SERVICE_URL = "http://localhost:4600/internal/series";
const SEARCH_SERVICE_SYNC_URL = "http://localhost:4800/internal/sync";
const TOKEN = "change-me"; // From .env

async function sync() {
    console.log("1. Fetching all series from Content Service (Production Sync)...");

    try {
        const res = await fetch(`${CONTENT_SERVICE_URL}?limit=100`, {
            headers: {
                "Authorization": `Bearer ${TOKEN}`,
                "x-service-token": TOKEN
            }
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch series: ${res.status} ${await res.text()}`);
        }

        const content = await res.json();
        const items = content.data?.items || [];
        console.log(`   Fetched ${items.length} series.`);

        // 2. Push to Search Service
        console.log("2. Syncing to Search Service with FULL payloads...");

        let successCount = 0;
        let failCount = 0;

        for (const item of items) {
            console.log(`   Syncing: ${item.title} (${item.id})`);

            // Map item to Search Schema payload
            // Now we send the FULL object structure to support rich search results
            const payload = {
                id: item.id,
                title: item.title,
                slug: item.slug,
                synopsis: item.synopsis || item.description,
                tags: item.tags || [],
                category: item.category?.name || item.category,
                releaseYear: item.publishedAt ? new Date(item.publishedAt).getFullYear() : undefined,
                heroImageUrl: item.heroImageUrl,
                thumbnail: item.heroImageUrl || item.thumbnail, // Fallback

                // Pass through rich fields
                status: item.status,
                visibility: item.visibility,
                publishedAt: item.publishedAt,
                createdAt: item.createdAt, // properties might differ in view model vs DB model, but item has what we need
                updatedAt: item.updatedAt,

                playback: item.playback,
                localization: item.localization,
                personalization: item.personalization,
                ratings: item.ratings,
                availability: item.availability,
                season: item.season,
                series: item.series
            };

            try {
                const syncRes = await fetch(SEARCH_SERVICE_SYNC_URL, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${TOKEN}`,
                        "x-service-token": TOKEN
                    },
                    body: JSON.stringify({
                        action: "upsert",
                        payload: payload
                    })
                });

                if (!syncRes.ok) {
                    console.error(`   ❌ Failed to sync ${item.title}: ${syncRes.status}`);
                    failCount++;
                } else {
                    successCount++;
                }
            } catch (err) {
                console.error(`   ❌ Error syncing ${item.title}:`, err.message);
                failCount++;
            }
        }

        console.log(`\nSync Complete. Success: ${successCount}, Failed: ${failCount}`);

    } catch (err) {
        console.error("Critical Error:", err);
    }
}

sync();
