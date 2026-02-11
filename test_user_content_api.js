// Native fetch is available in Node 18+
const myFetch = global.fetch;

// Config
const API_URL = "http://localhost:3000/api/v1";
// Token provided by user (same as test_admin_apis.js)
const ADMIN_TOKEN = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImF1dGgtc2VydmljZS1rZXkifQ.eyJzdWIiOiIxMDFmM2M4Yi0wZTY1LTRkZmYtYWIzZS02NTY0YWIzNzE4OTUiLCJ1c2VyVHlwZSI6IkFETUlOIiwiYWRtaW5JZCI6IjEwMWYzYzhiLTBlNjUtNGRmZi1hYjNlLTY1NjRhYjM3MTg5NSIsInJvbGVzIjpbIkFETUlOIl0sInNlc3Npb25JZCI6IjhhMDE4ODBiLTEyMjgtNDAxZC05NDQxLWYyMzQzYmNiNGZhNyIsImlzcyI6ImF1dGgtc2VydmljZSIsImF1ZCI6InBvY2tldGxvbC1zZXJ2aWNlcyIsImlhdCI6MTc3MDgwNTY4NywiZXhwIjoxNzcwODkyMDg3fQ.UiziYCJnrDjpp6EqHnVBPeCANYABInP9TuRNchQnm7VtgR0qT4AJ5dHDTSTzAWE0oO09Jfd0Rhi7eW_09MR-PoW76Un5EI-OfJiiZaO-c53IEfkriGoXcahi2SkeqYfSQvc_xLaVrfWqgzho71tU2wUPg0nEJJ5ZhOZ9uOkxLa1cZMWZ3G9WDzJZOYSbrbLg1QMVUAEM0i0QWzlEdX21hU1VmMopqDYdgGKhV1Ob194VDl51dEt_iIEvt70smK2KrctpyULkH8vnLg94O51G_WiS0kk6gMkc7fa6WaQyVKt8VcBQCqFsJ7t-3UOP5EEq4CZwv9sja1ES76tQZoX-hQ";
// userId provided by user: 83e9b618-258b-4fe6-a1d3-2297a5de4e54 (No data found)
// Found active user via script: 6087b703-8fad-4a0b-9daf-9a73d594ab8c
const USER_ID = "6087b703-8fad-4a0b-9daf-9a73d594ab8c";

async function testUserContentApi() {
    console.log("\n--- Testing User Content Analytics ---");
    const url = `${API_URL}/engagement/analytics/users/${USER_ID}/content?limit=5`;
    console.log(`Fetching: ${url}`);

    try {
        const response = await myFetch(url, {
            headers: {
                'Authorization': `Bearer ${ADMIN_TOKEN}`
            }
        });

        if (!response.ok) {
            console.error(`Request failed: ${response.status} ${response.statusText}`);
            try {
                const text = await response.text();
                console.error("Response body:", text);
            } catch (e) { }
            return;
        }

        const data = await response.json();
        console.log("Status: 200 OK");

        // Check Watch History
        const history = data.watchHistory || [];
        console.log(`Watch History Items: ${history.length}`);
        if (history.length > 0) {
            const first = history[0];
            console.log("Sample History Item:", JSON.stringify(first, null, 2));
            if (!first.title || first.title === "Unknown Episode" || first.title === "Unknown Content") {
                console.error("FAIL: Title is missing or unknown.");
            }
            if (!first.thumbnailUrl) {
                console.error("FAIL: Thumbnail is missing.");
            }
        } else {
            console.log("No watch history found for this user.");
        }

        // Check Pagination (if implemented)
        // If we requested limit=5, we expect around 5 items if there are more.

    } catch (err) {
        console.error("Error:", err.message);
    }
}

testUserContentApi();
