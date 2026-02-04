/**
 * Shared configuration for load tests
 */

// Base URL - can be overridden via environment variable
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

// Test thresholds
export const THRESHOLDS = {
    smoke: {
        http_req_duration: ['p(95)<500'],
        http_req_failed: ['rate<0.05'],
    },
    load: {
        http_req_duration: ['p(95)<300'],
        http_req_failed: ['rate<0.01'],
    },
    stress: {
        http_req_duration: ['p(95)<1000'],
        http_req_failed: ['rate<0.10'],
    },
};

// API Endpoints
export const ENDPOINTS = {
    // Health
    healthLive: '/health/live',
    healthReady: '/health/ready',

    // Auth (public)
    guestInit: '/api/v1/auth/guest/init',
    tokenRefresh: '/api/v1/auth/token/refresh',
    adminLogin: '/api/v1/auth/admin/login',
    customerLogin: '/api/v1/auth/customer/login',

    // Content (public)
    mobileHome: '/api/v1/content/mobile/home',

    // Search (public)
    search: '/api/v1/search',

    // Engagement (authenticated)
    seriesLike: (id) => `/api/v1/engagement/series/${id}/like`,
    seriesView: (id) => `/api/v1/engagement/series/${id}/view`,
    seriesSave: (id) => `/api/v1/engagement/series/${id}/save`,
    seriesStats: (id) => `/api/v1/engagement/series/${id}/stats`,
    reelLike: (id) => `/api/v1/engagement/reels/${id}/like`,
    reelView: (id) => `/api/v1/engagement/reels/${id}/view`,
    progress: '/api/v1/engagement/progress',
};

// Sample test data
export const TEST_DATA = {
    // Sample series UUIDs - replace with real IDs from your DB
    seriesIds: [
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
    ],
    reelIds: [
        '00000000-0000-0000-0000-000000000001',
    ],
    searchQueries: ['drama', 'comedy', 'action', 'romance', 'thriller'],
};

// Helper: Generate random device ID
export function generateDeviceId(vuId, iteration) {
    return `k6-device-${vuId}-${iteration}-${Date.now()}`;
}

// Helper: Random element from array
export function randomItem(array) {
    return array[Math.floor(Math.random() * array.length)];
}
