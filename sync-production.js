
// sync-production.js (Debug Version)
const CONTENT_SERVICE_URL = process.env.CONTENT_SERVICE_URL || "http://content-service:4600/internal/series";
const SEARCH_SERVICE_SYNC_URL = process.env.SEARCH_SERVICE_SYNC_URL || "http://localhost:4800/internal/sync";
const TOKEN = process.argv[2] || process.env.SERVICE_AUTH_TOKEN;

if (!TOKEN || TOKEN === "change-me") {
    console.error("Error: SERVICE_AUTH_TOKEN is not set.");
    process.exit(1);
}

async function sync() {
    console.log(`1. Fetching from: ${CONTENT_SERVICE_URL}`);
    try {
        const res = await fetch(`${CONTENT_SERVICE_URL}?limit=100`, {
            headers: { "Authorization": `Bearer ${TOKEN}`, "x-service-token": TOKEN }
        });
        if (!res.ok) {
            console.error(`Fetch from Content Service failed: ${res.status} ${await res.text()}`);
            process.exit(1);
        }
        const { data } = await res.json();
        const items = data?.items || [];
        console.log(`   Fetched ${items.length} series.`);

        console.log(`2. Syncing to: ${SEARCH_SERVICE_SYNC_URL}`);
        let success = 0, fail = 0;
        for (const item of items) {
            try {
                const syncRes = await fetch(SEARCH_SERVICE_SYNC_URL, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${TOKEN}`,
                        "x-service-token": TOKEN
                    },
                    body: JSON.stringify({ action: "upsert", payload: item })
                });

                if (syncRes.ok) {
                    success++;
                    process.stdout.write("."); // Progress indicator
                } else {
                    const errorText = await syncRes.text();
                    console.error(`\n   ❌ Failed to sync ${item.title}: ${syncRes.status} - ${errorText}`);
                    fail++;
                }
            } catch (e) {
                console.error(`\n   ❌ Network error syncing ${item.title}: ${e.message}`);
                fail++;
            }
        }
        console.log(`\n\nSync Complete. Success: ${success}, Failed: ${fail}`);
    } catch (err) { console.error("Critical Error:", err.message); }
}
sync();
