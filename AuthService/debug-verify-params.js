const fetch = require('node-fetch');

async function login(name) {
    console.log(`\n[${name}] Logging in...`);
    const res = await fetch('http://79gqnt61-3000.inc1.devtunnels.ms/api/v1/auth/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'superadmin@pocketlol.com', password: 'Test@1234' })
    });

    if (!res.ok) {
        console.error(`[${name}] Login Failed:`, await res.text());
        return null;
    }
    const data = await res.json();
    console.log(`[${name}] Login Response Keys:`, Object.keys(data));

    // Handle both direct and wrapped response formats
    const token = data.accessToken || (data.data && data.data.tokens && data.data.tokens.accessToken);

    if (!token) {
        console.error(`[${name}] ERROR: Could not find accessToken in response!`, JSON.stringify(data, null, 2));
        return null;
    }
    console.log(`[${name}] Token Extracted: ${token.substring(0, 20)}...`);

    // Decode and log token details
    const [header, payload] = token.split('.').slice(0, 2).map(part => JSON.parse(Buffer.from(part, 'base64').toString()));
    console.log(`[${name}] Token Header:`, JSON.stringify(header));
    console.log(`[${name}] Token Payload:`, JSON.stringify({ ...payload, roles: '...' })); // truncate roles

    return token;
}

async function verify(name, token) {
    console.log(`[${name}] Verifying...`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    try {
        const res = await fetch('http://79gqnt61-3000.inc1.devtunnels.ms/api/v1/auth/session/verify', {
            headers: { 'Authorization': `Bearer ${token}` },
            signal: controller.signal
        });
        clearTimeout(timeout);

        const text = await res.text();
        let json = {};
        try { json = JSON.parse(text); } catch (e) { }

        console.log(`[${name}] Verify Status: ${res.status}`);
        if (res.status !== 200) {
            console.log(`[${name}] Error Message: "${json.message || text}"`);
        } else {
            console.log(`[${name}] Result: Valid`);
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log(`[${name}] Error: Request timed out`);
        } else {
            console.log(`[${name}] Error: ${error.message}`);
        }
    }
}

async function run() {
    // 1. Device A Login
    const tokenA = await login('Device A');
    if (!tokenA) return;

    // 2. Device A Verify (Expect Valid)
    await verify('Device A', tokenA);

    // 3. Device B Login
    const tokenB = await login('Device B');
    if (!tokenB) return;

    // 4. Device B Verify (Expect Valid)
    await verify('Device B', tokenB);

    // 5. Device A Verify (Expect 401 Session Revoked)
    console.log('\n--- Checking Device A after Device B login ---');
    await verify('Device A', tokenA);

    // 6. Debug: Fetch JWKS from AuthService via Dev Tunnel
    console.log('\n--- Debug: Fetching JWKS ---');
    try {
        const jwksRes = await fetch('http://79gqnt61-3000.inc1.devtunnels.ms/api/v1/auth/.well-known/jwks.json');
        if (jwksRes.ok) {
            const jwks = await jwksRes.json();
            console.log('JWKS from Gateway/Auth:', JSON.stringify(jwks, null, 2));
            console.log('NOTE: Compare "kid" in JWKS above with "kid" in Token Header printed earlier.');
        } else {
            console.log('Failed to fetch JWKS:', await jwksRes.text());
        }
    } catch (e) {
        console.log('Error fetching JWKS:', e.message);
    }
}

run().catch(console.error);
