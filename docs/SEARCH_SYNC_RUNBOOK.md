# Search Sync & Indexing Incident Report

## 1. Problem Summary
Users reported that the Search functionality was broken.
**Symptoms:**
- `SearchService` was failing to start or stuck in a restart loop.
- Error logs showed: `Index 'series' not found` and `meili.waitForTask is not a function`.
- Even when running, search results had missing Series data (specifically `Category` names were missing).
- "Continue Watching" list on mobile contained duplicate entries for the same series.

## 2. Root Cause Analysis

### A. Search Service Crash
The `SearchService` attempts to create the Meilisearch index on startup.
- **Issue 1:** The error check `e.code === "index_not_found"` was too specific. Some Meilisearch versions returned a slightly different error code or message, causing the catch block to re-throw the error instead of handling it.
- **Issue 2:** The fix attempted to use `await task.waitForTask()`, but the `meilisearch-js` client version installed did not support this method on the task object directly, causing a secondary crash.

### B. Missing Data (Category)
The `ContentService` sends data to Search whenever a Series is created or updated.
- **Issue:** The `createSeries` and `updateSeries` methods returned the raw `Series` object from the database, which **did not include relations** (like `Category`).
- **Result:** The sync payload sent `category: undefined`, wiping out category data in the search index.

### C. Continue Watching Duplicates
The `MobileAppService` fetched the last N episodes watched.
- **Issue:** If a user binge-watched 10 episodes of "Series A", the list would show all 10 episodes, flooding the "Continue Watching" shelf.
- **Requirement:** Show only the *latest* watched episode per series.

## 3. The Solution

### Code Fixes
1.  **`SearchService/src/lib/meilisearch.ts`**:
    - Made error handling robust (checks for "not found" in error message).
    - Removed `waitForTask` and replaced it with a safe `setTimeout` loop to wait for index creation without crashing.

2.  **`ContentService/src/services/catalog-service.ts`**:
    - Updated `createSeries` and `updateSeries` to explicitly **fetch the category** (or the full series with relations) before sending the payload to `SearchService`.

3.  **`ContentService/src/services/mobile-app-service.ts`**:
    - Implemented "Over-fetching" strategy: Fetch 5x the limit of history items, then filter in memory to keep only the most recent episode for unique Series IDs.

## 4. Production Sync Runbook
Since the fixes only apply to *new* data, we had to manually backfill the existing production data.

### Prerequisites
- `kubectl` installed and authorized for the production cluster (`dev` namespace).
- `node` installed locally (or in Cloud Shell).

### Step-by-Step Guide

#### 1. Retrieve the Service Token
The sync script requires the protected `SERVICE_AUTH_TOKEN`.
```bash
# Decode the secret from the running cluster
kubectl get secret shared-secrets -n dev -o jsonpath="{.data.SERVICE_AUTH_TOKEN}" | base64 --decode
```
*Copy this token.*

#### 2. Configure the Script
Edit `sync-production.js`:
```javascript
const TOKEN = "YOUR_COPIED_TOKEN_HERE";
```

#### 3. Establish Tunnels (Port-Forwarding)
Open **two separate terminals** to forward traffic from your local machine (or Cloud Shell) to the internal K8s services.

**Terminal A (Content Service):**
```bash
# Forward local port 4600 to service port 4600
kubectl port-forward -n dev svc/content-service 4600:4600
```

**Terminal B (Search Service):**
```bash
# Forward local port 4800 to service port 4800
kubectl port-forward -n dev svc/search-service 4800:4800
```

#### 4. Execute Sync
In a 3rd terminal, run the script:
```bash
node sync-production.js
```
**Success Indicator:**
- Output should show: `Syncing: [Series Name] ...`
- Final message: `Sync Complete. Success: X, Failed: 0`

## 5. Verification
- **Search:** New and existing series contain full data (including Categories).
- **Mobile Home:** "Continue Watching" shows unique series.
- **Infrastructure:** `SearchService` pods are healthy and stable.
