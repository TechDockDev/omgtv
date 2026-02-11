// Native fetch is available in Node 18+
const myFetch = global.fetch;

// Money Heist Series ID
const missingSeriesIds = [
    "de2afbf6-a548-41ec-8541-907e2383cf38"
];

const SERVICE_URL = "http://localhost:4600/internal/catalog/batch";

async function checkIds(type, ids) {
    console.log(`\nChecking ${type} IDs...`);
    try {
        const response = await myFetch(SERVICE_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-service-token': 'change-me'
            },
            body: JSON.stringify({ ids, type })
        });

        if (!response.ok) {
            console.error(`Request failed: ${response.status} ${response.statusText}`);
            console.error(await response.text());
            return;
        }

        const data = await response.json();

        console.log("Response Type:", Array.isArray(data) ? "Array" : typeof data);
        if (!Array.isArray(data)) {
            console.log("Response Keys:", Object.keys(data));
        }

        // Handle wrapped response from globalResponsePlugin
        let items = [];
        if (data.data && Array.isArray(data.data.items)) {
            items = data.data.items;
            console.log("Found items in data.data.items");
        } else if (data.items && Array.isArray(data.items)) {
            items = data.items;
            console.log("Found items in data.items");
        } else if (Array.isArray(data)) {
            items = data;
            console.log("Found items as array response");
        }

        console.log(`Found ${items.length} items out of ${ids.length} requested.`);
        if (items.length > 0) {
            console.log("Sample Item Title:", items[0].title);
            console.log("Sample Item HeroImage:", items[0].heroImageUrl);
            console.log("Sample Item MediaAssets:", JSON.stringify(items[0].mediaAssets, null, 2));
        } else {
            console.log("No items found.");
        }
    } catch (err) {
        console.error("Error connecting to Content Service:", err.message);
    }
}

async function run() {
    await checkIds('series', missingSeriesIds);
}

run();
