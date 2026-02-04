/**
 * OMGTV Production Load Test
 * Target: 500 RPS, 5000 concurrent users
 * 
 * Usage:
 *   k6 run -e BASE_URL=https://api.yourdomain.com production-load-test.js
 *   k6 run --out json=results.json production-load-test.js
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

// Custom metrics
const errorRate = new Rate('error_rate');
const apiLatency = new Trend('api_latency');
const requestCount = new Counter('request_count');

// Test configuration
export const options = {
    stages: [
        { duration: '2m', target: 100 },    // Warm up
        { duration: '5m', target: 500 },    // Ramp to 500
        { duration: '10m', target: 1000 },  // Ramp to 1000
        { duration: '10m', target: 2000 },  // Ramp to 2000
        { duration: '5m', target: 5000 },   // Peak load
        { duration: '5m', target: 5000 },   // Sustain peak
        { duration: '5m', target: 0 },      // Ramp down
    ],

    thresholds: {
        http_req_duration: ['p(95)<300', 'p(99)<500'],
        http_req_failed: ['rate<0.01'],
        error_rate: ['rate<0.01'],
    },
};

const BASE_URL = __ENV.BASE_URL || 'https://api.yourdomain.com';
let guestTokens = {};

function api(method, endpoint, body = null, token = null) {
    const url = `${BASE_URL}${endpoint}`;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const start = Date.now();
    let res;
    const params = { headers, timeout: '30s' };

    switch (method) {
        case 'GET':
            res = http.get(url, params);
            break;
        case 'POST':
            res = http.post(url, body ? JSON.stringify(body) : null, params);
            break;
        case 'DELETE':
            res = http.del(url, null, params);
            break;
        default:
            res = http.get(url, params);
    }

    apiLatency.add(Date.now() - start);
    requestCount.add(1);

    return res;
}

export default function () {
    const vuId = __VU;
    const deviceId = `prod-test-${vuId}-${Date.now()}`;

    // 1. Guest Authentication
    group('auth', () => {
        const guest = api('POST', '/api/v1/auth/guest/init', {
            deviceId,
            deviceInfo: { platform: 'android', version: '2.0.0' },
        });

        if (check(guest, { 'guest auth ok': (r) => r.status === 200 })) {
            try {
                const data = JSON.parse(guest.body);
                guestTokens[vuId] = data.tokens?.accessToken;
            } catch (e) { }
        } else {
            errorRate.add(1);
        }
    });

    sleep(0.1);

    // 2. Home Feed (Critical Path)
    group('home_feed', () => {
        const home = api('GET', '/api/v1/content/mobile/home');
        check(home, {
            'home feed ok': (r) => r.status === 200,
            'home feed fast': (r) => r.timings.duration < 300,
        }) || errorRate.add(1);
    });

    sleep(0.1);

    // 3. Search
    group('search', () => {
        const queries = ['drama', 'comedy', 'action', 'romance', 'thriller', 'horror', 'mystery'];
        const q = queries[Math.floor(Math.random() * queries.length)];
        const search = api('GET', `/api/v1/search?q=${q}`);
        check(search, { 'search ok': (r) => r.status === 200 }) || errorRate.add(1);
    });

    sleep(0.1);

    // 4. Content Browsing
    group('content', () => {
        const series = api('GET', '/api/v1/content/mobile/series');
        check(series, { 'series ok': (r) => r.status === 200 || r.status === 404 });

        sleep(0.05);

        const reels = api('GET', '/api/v1/content/mobile/reels');
        check(reels, { 'reels ok': (r) => r.status === 200 || r.status === 404 });
    });

    sleep(0.1);

    // 5. Engagement (Authenticated)
    group('engagement', () => {
        const token = guestTokens[vuId];
        if (!token) return;

        const saved = api('GET', '/api/v1/engagement/series/saved', null, token);
        check(saved, { 'saved series ok': (r) => r.status === 200 || r.status === 401 });

        sleep(0.05);

        const liked = api('GET', '/api/v1/engagement/series/liked', null, token);
        check(liked, { 'liked series ok': (r) => r.status === 200 || r.status === 401 });
    });

    // Realistic think time
    sleep(Math.random() * 2 + 0.5);
}

export function setup() {
    console.log(`🚀 Starting Production Load Test`);
    console.log(`Target: ${BASE_URL}`);
    console.log(`Peak: 5000 concurrent users`);

    // Verify target is reachable
    const health = http.get(`${BASE_URL}/health/live`);
    if (health.status !== 200) {
        throw new Error(`Target not healthy: ${health.status}`);
    }
    console.log('✅ Target is healthy');
    return {};
}

export function teardown(data) {
    console.log('\n🏁 Production Load Test Complete!');
}

export function handleSummary(data) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return {
        [`results-${timestamp}.json`]: JSON.stringify(data, null, 2),
        stdout: textSummary(data, { indent: ' ', enableColors: true }),
    };
}
