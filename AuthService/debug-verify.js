const fetch = require('node-fetch');

async function login(name) {
    console.log(`\n[${name}] Logging in...`);
    const res = await fetch('http://localhost:4000/api/v1/auth/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'superadmin@pocketlol.com', password: 'Test@1234' })
    });

    if (!res.ok) {
        console.error(`[${name}] Login Failed:`, await res.text());
        return null;
    }
    const data = await res.json();
    console.log(`[${name}] Token Received`);
    return data;
}

async function verify(name, token) {
    console.log(`[${name}] Verifying...`);
    const res = await fetch('http://localhost:4000/api/v1/auth/session/verify', {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    console.log(`[${name}] Status:`, res.status);
    const text = await res.text();
    console.log(`[${name}] Response:`, text);
}

async function refresh(name, refreshToken) {
    console.log(`[${name}] Refreshing token...`);
    const res = await fetch('http://localhost:4000/api/v1/auth/token/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken })
    });

    if (!res.ok) {
        console.error(`[${name}] Refresh Failed:`, await res.text());
        return null;
    }
    const data = await res.json();
    console.log(`[${name}] Refresh Success. New Token Received.`);
    return data.accessToken;
}

async function run() {
    // 1. Login Device A
    const dataA = await login('Device A');
    if (!dataA) return;
    let tokenA = dataA.accessToken;

    // 2. Verify A (Should pass)
    await verify('Device A', tokenA);

    // 3. Refresh A
    const dataRefreshed = await refresh('Device A', dataA.refreshToken);
    if (!dataRefreshed) return;

    // 4a. Verify with REFRESH Token (Expected: 401 Invalid access token)
    console.log('\n[TEST] Attempting verify with REFRESH token (Invalid usage)...');
    await verify('Device A (Using Ref Token)', dataRefreshed.refreshToken);

    // 4b. Verify with ACCESS Token (Expected: 200)
    console.log('\n[TEST] Attempting verify with ACCESS token (Correct usage)...');
    await verify('Device A (Using Access Token)', dataRefreshed.accessToken);
}

run().catch(console.error);
