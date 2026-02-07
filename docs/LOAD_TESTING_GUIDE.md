# Load Testing Walkthrough

## 1. Prerequisites
You need **k6** installed on your local machine.
- **Windows**: `winget install k6` or download from [k6.io](https://grafana.com/docs/k6/latest/get-started/installation/)

## 2. Environment Setup
Make sure your local environment mirrors production settings as closely as possible (though resources will be limited).

1.  **Start Services**:
    ```powershell
    cd d:\nodejs\omgtv
    docker-compose down
    docker-compose up -d
    ```
    *Wait for all services to be "Healthy".*

2.  **Seed Data** (Optional but Recommended):
    If your database is empty, search tests won't find anything.
    You should have at least some data. If not, create a few series via the Admin API or directly in DB.

## 3. Running the Smoke Test (Sanity Check)
Run this first to ensure everything is wired up correctly.
```powershell
cd d:\nodejs\omgtv\load-tests
k6 run smoke-test.js
```
**Goal:** 0 Errors.

## 4. Running the Load Test
This simulates **50 concurrent users** hitting the Home Feed, Auth, and Search APIs.
```powershell
k6 run load-test.js
```
**Watch for:**
- **p95 Latency**: Should be under **300ms** (or 500ms since we added heavy math).
- **Error Rate**: Should be **0%**.

## 5. Analyzing Results
After the test finishes, you will see a summary table.

| Metric | What it means | Good Value |
|--------|---------------|------------|
| `http_req_duration` (p95) | 95% of requests were faster than this | < 500ms |
| `failed requests` | % of 500/503 errors | 0.00% |
| `requests_by_endpoint` | Traffic distribution | Evenly spread |

## 6. What if it fails?
- If **Search** is slow: Check `SearchService` logs for high CPU or restart loops.
- If **Home Feed** is slow: Check `ContentService` logs. The "Continue Watching" calculation might be heavy if you have huge watch history.
