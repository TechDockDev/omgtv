# Docker Service Fix Log - January 24, 2026

This document summarizes the changes made to resolve issues where several services in the `omgtv` project were failing to start or remains unhealthy.

## 1. Shell Script Compatibility (Alpine Linux)

**Root Cause:** The `docker-entrypoint.sh` scripts were using `set -euo pipefail`. Alpine Linux uses `ash` (via BusyBox) which does not support the `pipefail` option, causing the scripts to exit with code 127/1 immediately.

**Changes:**

- Modified `set -euo pipefail` to `set -e` in the following files:
  - `AuthService/docker-entrypoint.sh`
  - `ContentService/docker-entrypoint.sh`
  - `EngagementService/docker-entrypoint.sh`
  - `SearchService/docker-entrypoint.sh`
  - `StreamingService/docker-entrypoint.sh`
  - `SubscriptionService/docker-entrypoint.sh`
  - `UploadService/docker-entrypoint.sh`
  - `UserService/docker-entrypoint.sh`

## 2. Windows vs. Linux Line Endings (CRLF to LF)

**Root Cause:** Windows uses `\r\n` (CRLF) while Linux/Docker containers expect `\n` (LF). Shell scripts with CRLF fail to execute in Alpine containers with a "file not found" or "env: sh\r: No such file or directory" error.

**Changes:**

- Converted all `docker-entrypoint.sh` files to LF line endings.
- Updated all service **Dockerfiles** to include a safety fix during the build process:
  ```dockerfile
  RUN chmod +x docker-entrypoint.sh && sed -i 's/\r$//' docker-entrypoint.sh
  ```
- Impacted Services: `AuthService`, `ContentService`, `EngagementService`, `SearchService`, `StreamingService`, `SubscriptionService`, `UploadService`, `UserService`.

## 3. Missing Environment Variables

**Root Cause:** `SubscriptionService` was crashing because the Zod schema validation failed due to a missing required variable.

**Changes:**

- Added `RAZORPAY_WEBHOOK_SECRET=sample_webhook_secret` to `SubscriptionService/.env`.

## 4. API Gateway Healthcheck Fix

**Root Cause:** The `api-gateway` was remaining in an "unhealthy" state because the `curl` command used for healthchecks was not installed in the runtime image.

**Changes:**

- Modified `APIGW/Dockerfile` to install `curl` in the runtime stage:
  ```dockerfile
  RUN apk add --no-cache curl
  ```

## 5. Repository Normalization

- Ran `git add --renormalize .` to ensure Git correctly tracks these files with LF endings based on the `.gitattributes` configuration.

---

**Status:** All services (`postgres`, `redis`, `api-gateway`, `auth-service`, `user-service`, `content-service`, `engagement-service`, `search-service`, `streaming-service`, `subscription-service`, `upload-service`) are now running and healthy.
