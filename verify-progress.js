// verify-progress.js
const run = async () => {
    try {
        // 1. Get Guest Token
        console.log("1. Getting Guest Token...");
        const authRes = await fetch("http://localhost:3000/api/v1/auth/guest/init", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceId: "progress-test-device" })
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

        const TEST_EPISODE_ID = "22222222-2222-2222-2222-222222222222"; // Using a random UUID
        const TEST_PROGRESS = 150;
        const TEST_DURATION = 300;

        // 2. Test Save Progress (POST)
        console.log("2. Testing POST /api/v1/engagement/progress ...");
        const saveRes = await fetch("http://localhost:3000/api/v1/engagement/progress", {
            method: "POST",
            headers,
            body: JSON.stringify({
                episodeId: TEST_EPISODE_ID,
                progressSeconds: TEST_PROGRESS,
                durationSeconds: TEST_DURATION
            })
        });
        console.log(`   Save Status: ${saveRes.status}`);
        if (saveRes.status === 200) {
            const saveData = await saveRes.json();
            console.log("   Save Data:", JSON.stringify(saveData, null, 2));
        } else {
            console.error("   Save Fail:", await saveRes.text());
        }

        // 3. Test Get Progress (GET) - Should be immediate from Redis!
        console.log(`3. Testing GET /api/v1/engagement/progress/${TEST_EPISODE_ID} ...`);
        const getRes = await fetch(`http://localhost:3000/api/v1/engagement/progress/${TEST_EPISODE_ID}`, {
            method: "GET",
            headers
        });
        console.log(`   Get Status: ${getRes.status}`);
        if (getRes.status === 200) {
            const getData = await getRes.json();
            console.log("   Get Data:", JSON.stringify(getData, null, 2));

            if (getData.data?.progressSeconds === TEST_PROGRESS) {
                console.log("   ✅ Progress matches!");
            } else {
                console.error("   ❌ Progress value mismatch!");
            }
        } else {
            console.error("   Get Fail:", await getRes.text());
        }

    } catch (err) {
        console.error("CRITICAL ERROR:", err);
    }
};

run();
