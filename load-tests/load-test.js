/**
 * OMGTV - Load Test (Phase 2)
 * 
 * Purpose: Test expected peak load on local Docker environment
 * Target: 50 concurrent users, 5 minutes, comprehensive API coverage
 * 
 * Usage: k6 run load-test.js
 * 
 * NOTE: Run only AFTER smoke-test.js passes with 0 errors
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

// Custom metrics
const errorRate = new Rate('errors');
const apiLatency = new Trend('api_latency');
const requestsPerEndpoint = new Counter('requests_by_endpoint');

// Test configuration - LOAD TEST (medium load for local)
export const options = {
    stages: [
        { duration: '1m', target: 25 },   // Ramp up
        { duration: '3m', target: 50 },   // Sustained load
        { duration: '1m', target: 0 },    // Ramp down
    ],
    thresholds: {
        http_req_duration: ['p(95)<300', 'p(99)<500'],
        http_req_failed: ['rate<0.01'],
        errors: ['rate<0.01'],
    },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

// Search queries to simulate real traffic
const searchQueries = ['drama', 'comedy', 'action', 'romance', 'thriller', 'horror', 'mystery'];

// Request helper
function api(method, endpoint, body = null, token = null) {
    const url = `${BASE_URL}${endpoint}`;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    let res;
    if (method === 'GET') {
        res = http.get(url, { headers, timeout: '15s' });
    } else if (method === 'POST') {
        res = http.post(url, body ? JSON.stringify(body) : null, { headers, timeout: '15s' });
    } else if (method === 'DELETE') {
        res = http.del(url, null, { headers, timeout: '15s' });
    }

    apiLatency.add(res.timings.duration);
    return res;
}

// Simulated user session
let guestTokens = {};

export default function () {
    const vuId = __VU;
    const iteration = __ITER;

    // ============================================
    // SCENARIO: Typical User Session
    // ============================================

    // 1. App Open - Health Check
    group('01_App_Startup', () => {
        const health = api('GET', '/health/ready');
        check(health, { 'health ok': (r) => r.status === 200 }) || errorRate.add(1);
    });

    sleep(0.2);

    // 2. Guest Login (first time user)
    group('02_Guest_Auth', () => {
        const deviceId = `k6-${vuId}-${iteration}`;
        const guestInit = api('POST', '/api/v1/auth/guest/init', {
            deviceId: deviceId,
            deviceInfo: { platform: 'android', version: '2.0.0' },
        });

        if (check(guestInit, { 'guest init ok': (r) => r.status === 200 })) {
            try {
                const data = JSON.parse(guestInit.body);
                guestTokens[vuId] = {
                    access: data.tokens?.accessToken,
                    refresh: data.tokens?.refreshToken,
                };
            } catch (e) { }
        } else {
            errorRate.add(1);
        }
    });

    sleep(0.3);

    // 3. Load Home Feed (Most important API)
    group('03_Home_Feed', () => {
        const home = api('GET', '/api/v1/content/mobile/home');
        const passed = check(home, {
            'home feed 200': (r) => r.status === 200,
            'home feed fast': (r) => r.timings.duration < 400,
            'home feed has content': (r) => {
                try {
                    const body = JSON.parse(r.body);
                    return body && (body.carousels || body.sections || body.items);
                } catch {
                    return false;
                }
            },
        });
        if (!passed) errorRate.add(1);
    });

    sleep(0.5);

    // 4. Search (Random query)
    group('04_Search', () => {
        const query = searchQueries[Math.floor(Math.random() * searchQueries.length)];
        const search = api('GET', `/api/v1/search?q=${query}`);
        check(search, {
            'search ok': (r) => r.status === 200,
            'search fast': (r) => r.timings.duration < 200,
        }) || errorRate.add(1);
    });

    sleep(0.3);

    // 5. Content browsing (simulate series detail views)
    group('05_Browse_Content', () => {
        // Request series list/tags
        const token = guestTokens[vuId]?.access;

        // Try to get series data (public endpoint)
        const series = api('GET', '/api/v1/content/mobile/series');
        check(series, {
            'series list ok': (r) => r.status === 200 || r.status === 404,
        });
    });

    sleep(0.5);

    // 6. Token Refresh (simulates long session)
    group('06_Token_Refresh', () => {
        const refreshToken = guestTokens[vuId]?.refresh;
        if (refreshToken) {
            const refresh = api('POST', '/api/v1/auth/token/refresh', {
                refreshToken: refreshToken,
                deviceId: `k6-${vuId}-${iteration}`,
            });

            if (check(refresh, { 'refresh ok': (r) => r.status === 200 })) {
                try {
                    const data = JSON.parse(refresh.body);
                    guestTokens[vuId].access = data.tokens?.accessToken;
                    guestTokens[vuId].refresh = data.tokens?.refreshToken;
                } catch (e) { }
            }
        }
    });

    // Think time between iterations
    sleep(Math.random() * 2 + 1);
}

export function setup() {
    console.log(`🚀 Starting Load Test against: ${BASE_URL}`);
    console.log('Target: 50 concurrent users for 5 minutes');

    // Verify API is up
    const health = http.get(`${BASE_URL}/health/live`);
    if (health.status !== 200) {
        throw new Error(`API not healthy: ${health.status}`);
    }
    console.log('✅ API Gateway healthy');
    return {};
}

export function teardown(data) {
    console.log('\n📊 Load Test Complete!');
    console.log('Review the metrics above for:');
    console.log('  - p95 latency (target: <300ms)');
    console.log('  - Error rate (target: <1%)');
    console.log('  - Requests/sec achieved');
}
