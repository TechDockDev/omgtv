// verify-search.js
const run = async () => {
    try {
        // 1. Get Guest Token
        console.log("1. Getting Guest Token...");
        const authRes = await fetch("http://localhost:3000/api/v1/auth/guest/init", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceId: `search-test-${Date.now()}` })
        });

        if (!authRes.ok) throw new Error(`Auth failed: ${authRes.status}`);
        const authData = await authRes.json();
        const token = authData.data?.tokens?.accessToken;

        if (!token) throw new Error("No token received");
        console.log("   Token received.");

        const headers = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
        };

        // 1.5 Seed History (Search for 'Introduction')
        console.log("\n1.5 Seeding History (Search for 'Seed')...");
        await fetch(`http://localhost:3000/api/v1/search?q=Seed`, {
            method: "GET",
            headers
        });

        // 2. Perform Search (Empty Query - Browse)
        console.log("\n2. Testing GET /api/v1/search (Empty Query - Browse)...");
        const browseRes = await fetch("http://localhost:3000/api/v1/search", {
            method: "GET",
            headers
        });
        console.log(`   Browse Status: ${browseRes.status}`);
        if (browseRes.status === 200) {
            const data = await browseRes.json();
            console.log(`   Items found: ${data.data?.items?.length || 0}`);
            if (data.data?.items) {
                console.log("   Titles:", data.data.items.map(i => i.title).join(", "));
            }
            if (data.data?.history) console.log(`   History items: ${data.data.history.length}`);
        } else {
            console.error("   Browse Fail:", await browseRes.text());

            // Retry with trailing slash
            console.log("\n2b. Testing GET /api/v1/search/ (Trailing Slash)...");
            const browseRes2 = await fetch("http://localhost:3000/api/v1/search/", {
                method: "GET",
                headers
            });
            console.log(`   Browse (/) Status: ${browseRes2.status}`);
            if (browseRes2.status === 200) {
                const data = await browseRes2.json();
                console.log(`   Items found: ${data.data?.items?.length || 0}`);
            } else {
                console.error("   Browse (/) Fail:", await browseRes2.text());
            }
        }

        // 3. Perform Search (With Query "bad")
        const query = "bad";
        console.log(`\n3. Testing GET /api/v1/search?q=${query}...`);
        const searchRes = await fetch(`http://localhost:3000/api/v1/search?q=${query}`, {
            method: "GET",
            headers
        });
        console.log(`   Search Status: ${searchRes.status}`);
        if (searchRes.status === 200) {
            const data = await searchRes.json();
            console.log(`   Items found: ${data.data?.items?.length || 0}`);
            if (data.data?.items?.length > 0) {
                console.log(`   First Item: ${data.data.items[0].title}`);
                console.log("   Details:", JSON.stringify(data.data.items[0], null, 2));
            }
            if (data.data?.history) console.log(`   History items: ${data.data.history.length}`);
        } else {
            console.error("   Search Fail:", await searchRes.text());
        }

        // 4. Verify History (Empty Query again to see history update)
        // Wait a bit as history is async (fire-and-forget)
        await new Promise(r => setTimeout(r, 3000));

        console.log("\n4. Verifying History Update (GET /api/v1/search)...");
        const historyRes = await fetch("http://localhost:3000/api/v1/search", {
            method: "GET",
            headers
        });
        if (historyRes.status === 200) {
            const data = await historyRes.json();
            const history = data.data?.history || [];
            console.log(`   History items: ${history.length}`);
            const foundReq = history.find(h => h.query === query);
            if (foundReq) {
                console.log(`   ✅ Found history entry for '${query}'`);
            } else {
                console.log(`   ❌ History entry for '${query}' NOT found. History:`, JSON.stringify(history));
            }
        }

    } catch (err) {
        console.error("CRITICAL ERROR:", err);
    }
};

run();
