/**
 * OMGTV - Smoke Test (Phase 1) - EXPANDED
 * 
 * Purpose: Catch crashes, find N+1 queries, verify API stability
 * Tests: Health, Content, Search, Auth, Series, Reels, Engagement
 * 
 * Usage: k6 run smoke-test.js
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('errors');
const apiTrend = new Trend('api_response_time');

// Test configuration - SMOKE TEST (light load)
export const options = {
    stages: [
        { duration: '30s', target: 5 },   // Ramp up slowly
        { duration: '2m', target: 10 },   // Stay at 10 users (reduced from 20)
        { duration: '30s', target: 0 },   // Ramp down
    ],
    thresholds: {
        http_req_duration: ['p(95)<500'],
        http_req_failed: ['rate<0.15'],   // Allow 15% for expected 401/404
        errors: ['rate<0.10'],
    },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

// Store tokens for authenticated requests
let guestData = {};

// Helper function for requests
function api(method, endpoint, body = null, token = null) {
    const url = `${BASE_URL}${endpoint}`;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    let response;
    const params = { headers, timeout: '10s' };

    switch (method) {
        case 'GET':
            response = http.get(url, params);
            break;
        case 'POST':
            response = http.post(url, body ? JSON.stringify(body) : null, params);
            break;
        case 'DELETE':
            response = http.del(url, null, params);
            break;
        default:
            response = http.get(url, params);
    }

    apiTrend.add(response.timings.duration);
    return response;
}

export default function () {
    const vuId = __VU;
    const iteration = __ITER;
    const deviceId = `k6-device-${vuId}-${Date.now()}`;

    // ============================================
    // 1. HEALTH CHECKS
    // ============================================
    group('01_Health_Checks', () => {
        const healthCheck = api('GET', '/health/live');
        check(healthCheck, {
            'health check 200': (r) => r.status === 200,
        }) || errorRate.add(1);

        const readyCheck = api('GET', '/health/ready');
        check(readyCheck, {
            'ready check 200': (r) => r.status === 200,
        }) || errorRate.add(1);
    });

    sleep(0.3);

    // ============================================
    // 2. GUEST AUTH (Get tokens for later)
    // ============================================
    group('02_Guest_Auth', () => {
        const guestInit = api('POST', '/api/v1/auth/guest/init', {
            deviceId: deviceId,
            deviceInfo: { platform: 'android', version: '1.0.0' },
        });

        const passed = check(guestInit, {
            'guest init 200': (r) => r.status === 200,
            'guest init fast': (r) => r.timings.duration < 500,
        });

        if (passed && guestInit.status === 200) {
            try {
                const data = JSON.parse(guestInit.body);
                guestData[vuId] = {
                    accessToken: data.tokens?.accessToken,
                    refreshToken: data.tokens?.refreshToken,
                    guestId: data.guestId,
                };
            } catch (e) {
                errorRate.add(1);
            }
        } else {
            errorRate.add(1);
        }
    });

    sleep(0.3);

    // ============================================
    // 3. PUBLIC CONTENT APIs
    // ============================================
    group('03_Content_APIs', () => {
        // Mobile Home Feed
        const home = api('GET', '/api/v1/content/mobile/home');
        check(home, {
            'home feed 200': (r) => r.status === 200,
            'home feed fast': (r) => r.timings.duration < 500,
        }) || errorRate.add(1);

        sleep(0.2);

        // Mobile Series List
        const series = api('GET', '/api/v1/content/mobile/series');
        check(series, {
            'series list ok': (r) => r.status === 200 || r.status === 404,
        });

        sleep(0.2);

        // Mobile Reels
        const reels = api('GET', '/api/v1/content/mobile/reels');
        check(reels, {
            'reels list ok': (r) => r.status === 200 || r.status === 404,
        });

        sleep(0.2);

        // Audio Series (if available)
        const audioSeries = api('GET', '/api/v1/content/mobile/audio-series');
        check(audioSeries, {
            'audio series ok': (r) => r.status === 200 || r.status === 404,
        });
    });

    sleep(0.3);

    // ============================================
    // 4. SEARCH
    // ============================================
    group('04_Search', () => {
        const queries = ['drama', 'comedy', 'action', 'love', 'thriller'];
        const query = queries[Math.floor(Math.random() * queries.length)];

        const search = api('GET', `/api/v1/search?q=${query}`);
        check(search, {
            'search 200': (r) => r.status === 200,
            'search fast': (r) => r.timings.duration < 300,
        }) || errorRate.add(1);
    });

    sleep(0.3);

    // ============================================
    // 5. ENGAGEMENT APIs (Authenticated)
    // ============================================
    group('05_Engagement', () => {
        const token = guestData[vuId]?.accessToken;
        if (!token) return;

        // Get saved series
        const savedSeries = api('GET', '/api/v1/engagement/series/saved', null, token);
        check(savedSeries, {
            'saved series ok': (r) => r.status === 200 || r.status === 401,
        });

        sleep(0.2);

        // Get liked series
        const likedSeries = api('GET', '/api/v1/engagement/series/liked', null, token);
        check(likedSeries, {
            'liked series ok': (r) => r.status === 200 || r.status === 401,
        });

        sleep(0.2);

        // Get saved reels
        const savedReels = api('GET', '/api/v1/engagement/reels/saved', null, token);
        check(savedReels, {
            'saved reels ok': (r) => r.status === 200 || r.status === 401,
        });

        sleep(0.2);

        // Get liked reels
        const likedReels = api('GET', '/api/v1/engagement/reels/liked', null, token);
        check(likedReels, {
            'liked reels ok': (r) => r.status === 200 || r.status === 401,
        });
    });

    sleep(0.3);

    // ============================================
    // 6. TOKEN REFRESH
    // ============================================
    group('06_Token_Refresh', () => {
        const refreshToken = guestData[vuId]?.refreshToken;
        if (!refreshToken) return;

        const refresh = api('POST', '/api/v1/auth/token/refresh', {
            refreshToken: refreshToken,
            deviceId: deviceId,
        });

        if (check(refresh, { 'token refresh ok': (r) => r.status === 200 })) {
            try {
                const data = JSON.parse(refresh.body);
                guestData[vuId].accessToken = data.tokens?.accessToken;
                guestData[vuId].refreshToken = data.tokens?.refreshToken;
            } catch (e) { }
        }
    });

    // Think time
    sleep(1);
}

export function setup() {
    console.log(`🎯 Starting Expanded Smoke Test against: ${BASE_URL}`);
    console.log('Testing: Health, Auth, Content, Search, Series, Reels, Engagement');

    const health = http.get(`${BASE_URL}/health/live`);
    if (health.status !== 200) {
        throw new Error(`API Gateway not healthy! Status: ${health.status}`);
    }
    console.log('✅ API Gateway is healthy');
    return {};
}

export function teardown(data) {
    console.log('\n🏁 Smoke Test Complete!');
    console.log('If error rate < 10%: Proceed to load-test.js');
}
