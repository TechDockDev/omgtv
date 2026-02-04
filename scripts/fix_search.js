// scripts/fix_search.js
// Run this script to:
// 1. Create the missing 'series' index in Meilisearch
// 2. Trigger a full re-sync of data from ContentService to SearchService

const MEILI_HOST = "http://localhost:7700"; // Port forwarded or local
const MEILI_MASTER_KEY = "masterKey";       // From k8s secrets (default dev value)
const SEARCH_SERVICE_SYNC = "http://localhost:4800/internal/sync"; // Port forwarded or local
const CONTENT_SERVICE_URL = "http://localhost:4600/internal/series"; // Port forwarded or local
const SERVICE_TOKEN = "change-me"; // Need actual token or dev default

const INDEX_NAME = "series";

async function run() {
    console.log("🚀 Starting Search Repair...");

    // STEP 1: Create Index
    console.log(`\n1️⃣ Checking/Creating Meilisearch Index '${INDEX_NAME}'...`);
    try {
        // Check if exists
        const checkRes = await fetch(`${MEILI_HOST}/indexes/${INDEX_NAME}`, {
            headers: { "Authorization": `Bearer ${MEILI_MASTER_KEY}` }
        });

        if (checkRes.status === 200) {
            console.log("   ✅ Index already exists.");
        } else {
            console.log("   ❌ Index missing. Creating...");
            const createRes = await fetch(`${MEILI_HOST}/indexes`, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${MEILI_MASTER_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ uid: INDEX_NAME, primaryKey: "id" })
            });

            if (!createRes.ok) throw new Error(`Failed to create index: ${await createRes.text()}`);

            const task = await createRes.json();
            console.log(`   ✅ Index creation task started (Task UID: ${task.taskUid}). Waiting...`);

            // Wait for task
            await new Promise(r => setTimeout(r, 2000));
        }

        // Apply Settings (Typo tolerance etc)
        console.log("   ⚙ Applying index settings...");
        const settingsRes = await fetch(`${MEILI_HOST}/indexes/${INDEX_NAME}/settings`, {
            method: "PATCH",
            headers: {
                "Authorization": `Bearer ${MEILI_MASTER_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                searchableAttributes: ["title", "category", "tags", "synopsis"],
                filterableAttributes: ["genre", "language", "releaseYear", "category", "status"],
                typoTolerance: { enabled: true }
            })
        });
        if (settingsRes.ok) console.log("   ✅ Settings updated.");
        else console.warn(`   ⚠️ Settings update warning: ${await settingsRes.text()}`);

    } catch (err) {
        console.error("   🔥 Error manipulating Meilisearch:", err.message);
        console.error("      Make sure you have port-forwarded Meilisearch: kubectl port-forward svc/meilisearch 7700:7700");
        return;
    }

    // STEP 2: Re-Sync Data
    console.log("\n2️⃣ Fetching data from ContentService...");
    let items = [];
    try {
        const res = await fetch(`${CONTENT_SERVICE_URL}?limit=1000`, { // Fetch all (up to 1000)
            headers: {
                "Authorization": `Bearer ${SERVICE_TOKEN}`,
                "x-service-token": SERVICE_TOKEN
            }
        });

        if (!res.ok) throw new Error(`Failed to fetch content: ${res.status}`);
        const json = await res.json();
        items = json.data?.items || [];
        console.log(`   ✅ Fetched ${items.length} items from ContentService.`);
    } catch (err) {
        console.error("   🔥 Error fetching content:", err.message);
        console.error("      Make sure ContentService is reachable: kubectl port-forward svc/content-service 4600:4600");
        return;
    }

    if (items.length === 0) {
        console.log("   ⚠️ No items to sync. Exiting.");
        return;
    }

    // STEP 3: Push to SearchService
    console.log(`\n3️⃣ Pushing ${items.length} items to SearchService...`);
    let success = 0, fail = 0;

    for (const item of items) {
        const payload = {
            id: item.id,
            title: item.title,
            slug: item.slug,
            synopsis: item.synopsis || item.description,
            tags: item.tags || [],
            category: item.category?.name || item.category,
            releaseYear: item.publishedAt ? new Date(item.publishedAt).getFullYear() : undefined,
            heroImageUrl: item.heroImageUrl,
            thumbnail: item.heroImageUrl || item.thumbnail,
            status: item.status,
            // ... add other fields if needed, relying on SearchService to map or pass through
        };

        try {
            const syncRes = await fetch(SEARCH_SERVICE_SYNC, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${SERVICE_TOKEN}`,
                    "x-service-token": SERVICE_TOKEN
                },
                body: JSON.stringify({ action: "upsert", payload })
            });

            if (syncRes.ok) success++;
            else {
                console.error(`      ❌ Failed ${item.title}: ${await syncRes.text()}`);
                fail++;
            }
        } catch (err) {
            console.error(`      ❌ Network error ${item.title}:`, err.message);
            fail++;
        }
    }

    console.log(`\n🎉 DONE! Success: ${success}, Failed: ${fail}`);
    console.log(`\n👉 NOW verify search: curl -X POST http://localhost:7700/indexes/${INDEX_NAME}/search -H "Authorization: Bearer ${MEILI_MASTER_KEY}" -H "Content-Type: application/json" -d '{ "q": "" }'`);
}

run();
