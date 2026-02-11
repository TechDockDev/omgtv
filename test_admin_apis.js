// Native fetch is available in Node 18+

// Token provided by user
const ACCESS_TOKEN = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImF1dGgtc2VydmljZS1rZXkifQ.eyJzdWIiOiIxMDFmM2M4Yi0wZTY1LTRkZmYtYWIzZS02NTY0YWIzNzE4OTUiLCJ1c2VyVHlwZSI6IkFETUlOIiwiYWRtaW5JZCI6IjEwMWYzYzhiLTBlNjUtNGRmZi1hYjNlLTY1NjRhYjM3MTg5NSIsInJvbGVzIjpbIkFETUlOIl0sInNlc3Npb25JZCI6IjhhMDE4ODBiLTEyMjgtNDAxZC05NDQxLWYyMzQzYmNiNGZhNyIsImlzcyI6ImF1dGgtc2VydmljZSIsImF1ZCI6InBvY2tldGxvbC1zZXJ2aWNlcyIsImlhdCI6MTc3MDgwNTY4NywiZXhwIjoxNzcwODkyMDg3fQ.UiziYCJnrDjpp6EqHnVBPeCANYABInP9TuRNchQnm7VtgR0qT4AJ5dHDTSTzAWE0oO09Jfd0Rhi7eW_09MR-PoW76Un5EI-OfJiiZaO-c53IEfkriGoXcahi2SkeqYfSQvc_xLaVrfWqgzho71tU2wUPg0nEJJ5ZhOZ9uOkxLa1cZMWZ3G9WDzJZOYSbrbLg1QMVUAEM0i0QWzlEdX21hU1VmMopqDYdgGKhV1Ob194VDl51dEt_iIEvt70smK2KrctpyULkH8vnLg94O51G_WiS0kk6gMkc7fa6WaQyVKt8VcBQCqFsJ7t-3UOP5EEq4CZwv9sja1ES76tQZoX-hQ";

const BASE_URL = "http://localhost:3000/api/v1";

async function testEndpoint(name, url) {
    console.log(`\n--- Testing ${name} ---`);
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        console.log(`Status: ${response.status} ${response.statusText}`);

        if (!response.ok) {
            const text = await response.text();
            console.error('Error Body:', text);
            return;
        }

        const data = await response.json();

        if (name === "Dashboard Analytics") {
            const content = data.data?.contentPerformance;
            console.log("Top Series Count:", content?.topSeries?.length);
            console.log("Top Reels Count:", content?.topReels?.length);
            if (content?.topSeries?.length > 0) {
                console.log("Sample Series Title:", content.topSeries[0].title);
                console.log("Sample Series ID:", content.topSeries[0].id);
                console.log("Sample Series Thumbnail:", content.topSeries[0].thumbnailUrl);
            }
            console.log("Top Screens:", data.data?.topScreens);
        } else if (name === "Admin Users") {
            console.log("User Stats:", data.stats);
            console.log("Total Users Fetched:", data.data?.items?.length);
        } else {
            console.log("Response Data Preview:", JSON.stringify(data).substring(0, 200) + "...");
        }

    } catch (error) {
        console.error(`Failed to test ${name}:`, error.message);
    }
}

async function runTests() {
    await testEndpoint("Dashboard Analytics", `${BASE_URL}/engagement/analytics/dashboard?granularity=daily`);
    await testEndpoint("Admin Users", `${BASE_URL}/user/admin/app-users?page=1&limit=20`);
}

runTests();
