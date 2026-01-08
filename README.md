# PocketLOL Microservices

This workspace contains the complete PocketLOL microservices stack including the API Gateway, Auth Service, User Service, Content Service, Engagement Service, Search Service, Streaming Service, and Upload Service. The stack ships with a unified Docker Compose workflow so you can run the full architecture locally with one command.

## Prerequisites

- Docker 24+ (or Docker Desktop)

## Environment Setup

1. Copy the template and populate your secrets (JWT keys, service token, etc.). The populated file is Git-ignored by default:

    ```bash
    cp infra-local/.env.example infra-local/.env
    ```

2. Edit `infra-local/.env` and update at least the following values:
    - `SERVICE_AUTH_TOKEN` — shared token for internal service auth
    - `AUTH_JWT_PRIVATE_KEY` / `AUTH_JWT_PUBLIC_KEY` — PEM-encoded keys for AuthService
    - Database credentials if you are not using the defaults

    Keep the PEM content wrapped in quotes so Docker Compose injects the line breaks correctly. Never commit the filled `.env` file.

## Build, Run, and Rebuild

From the repository root (or inside `infra-local/`), use the commands below.

- **Initial build and launch**

   ```bash
   docker compose --env-file .env up --build
   ```

   The first run seeds `pocketlol_auth` and `pocketlol_users` and applies Prisma migrations automatically. After the health checks pass, services are reachable at:
  - API Gateway → <http://localhost:${GATEWAY_HTTP_HOST_PORT:-3000}>
  - Auth Service → <http://localhost:${AUTH_SERVICE_HTTP_HOST_PORT:-4000}>
  - User Service → <http://localhost:${USER_SERVICE_HTTP_HOST_PORT:-4500}> (gRPC at `localhost:${USER_SERVICE_GRPC_HOST_PORT:-50052}`)
  - Content Service → <http://localhost:${CONTENT_SERVICE_HTTP_HOST_PORT:-4600}>
  - Engagement Service → <http://localhost:${ENGAGEMENT_SERVICE_HTTP_HOST_PORT:-4700}>
  - Search Service → <http://localhost:${SEARCH_SERVICE_HTTP_HOST_PORT:-4800}>
  - Streaming Service → <http://localhost:${STREAMING_SERVICE_HTTP_HOST_PORT:-4900}>
  - Upload Service → <http://localhost:${UPLOAD_SERVICE_HTTP_HOST_PORT:-5000}>

- **Stop the stack** (graceful shutdown)

   ```bash
   docker compose --env-file .env down
   ```

- **Rebuild after code changes** (forces image rebuild before starting)

   ```bash
   docker compose --env-file .env up --build --force-recreate --remove-orphans
   ```

- **Recreate without rebuilding images** (useful after config changes only)

   ```bash
   docker compose --env-file .env up --force-recreate
   ```

- **Clean everything** (containers, networks, volumes)

   ```bash
   docker compose --env-file .env down --volumes --remove-orphans
   ```

   Run this when you want to reset databases or caches.

The shared service token is read from `.env` so all containers use the same value automatically.

## Data & Migrations

- PostgreSQL runs inside Docker with a persistent `postgres-data` volume.
- Databases `pocketlol_auth` and `pocketlol_users` are created via `docker/postgres/01-init-databases.sql`.
- Each service entrypoint runs `prisma migrate deploy` (or `prisma db push` when no migrations exist) before starting the HTTP server.

## GitHub & CI/CD

- Store sensitive values (service token, JWT keys, database passwords) as GitHub Secrets. Suggested names: `INFRA_SERVICE_AUTH_TOKEN`, `INFRA_JWT_PRIVATE_KEY`, etc.
- CI workflows can reconstruct the `.env` file from secrets and execute

   ```bash
   docker compose --env-file .env up --build --detach
   ```

   on the runner or target host.
- Self-hosted runners should mount this directory so they reuse the same compose stack as developers.

## Local Development Outside Docker

You can still run services directly with Node.js. Refer to the service-specific guides:

- [APIGW/README.md](../APIGW/README.md)
- [AuthService/README.md](../AuthService/README.md)
- [UserService/README.md](../UserService/README.md)
- [ContentService/README.md](../ContentService/README.md)
- [EngagementService/README.md](../EngagementService/README.md)
- [SearchService/README.md](../SearchService/README.md)
- [StreamingService/README.md](../StreamingService/README.md)
- [UploadService/README.md](../UploadService/README.md)

Keep each service's standalone `.env` files in sync with the values defined in `infra-local/.env` (especially `SERVICE_AUTH_TOKEN` and database connection strings) to avoid mismatched credentials.

## GCP / GKE (Production) — End-to-end

This repo is already wired for GKE deployment via Kubernetes manifests and GitHub Actions.

### Live entrypoint (API Gateway)

- **Current public API endpoint (dev):** `http://136.110.255.90`
- Health: `http://136.110.255.90/health/live`

In GKE, APIGW is exposed by a GCE Ingress named `apigw`. A custom domain can be added later via DNS + a managed certificate (see `deploygcp.md`).

### Current GCP environment (this workspace)

These values reflect the environment that’s already been provisioned and validated from this repo:

- GCP Project: `pocketlol-68ca6`
- Region: `asia-south1`
- GKE cluster: `pocketlol` (Autopilot)
- Ingress external IP (dev): `136.110.255.90`
- Artifact Registry base: `asia-south1-docker.pkg.dev/pocketlol-68ca6/pocketlol`
- Cloud SQL connection name: `pocketlol-68ca6:asia-south1:pocketlol-pg`
- Redis (Memorystore): `redis://10.117.209.35:6379`
- Pub/Sub:
  - Topic: `projects/pocketlol-68ca6/topics/streaming-audit`
  - Topic: `projects/pocketlol-68ca6/topics/uploaded-media`
  - Subscription: `projects/pocketlol-68ca6/subscriptions/uploaded-media-sub`
- GCS:
  - Upload bucket: `pocketlol-68ca6-uploads`
  - Streaming manifests bucket: `pocketlol-68ca6-streaming-manifests`

### URL inventory (what talks to what)

- Public
  - API Gateway: `http://136.110.255.90` (dev)
  - Health: `http://136.110.255.90/health/live`
- Cluster-internal service URLs (used by APIGW and service-to-service calls)
  - AuthService: `http://auth-service:4000`
  - UserService: `http://user-service:4500`
  - ContentService: `http://content-service:4600`
  - EngagementService: `http://engagement-service:4700`
  - SearchService: `http://search-service:4800`
  - StreamingService: `http://streaming-service:4900`
  - UploadService: `http://upload-service:5000`
  - SubscriptionService: `http://subscription-service:5100`

Note: the services are **not** exposed publicly by default; only APIGW is.

### GCP resource inventory (what exists / what you should expect)

These are the main moving pieces for the GKE deployment model used in this repo:

- **GKE Autopilot**: runs all microservices as Deployments
- **Artifact Registry (Docker)**: stores images for `apigw`, `auth-service`, `content-service`, etc.
- **Cloud SQL (Postgres)**: used by Prisma services (Auth/User/Content/Upload/Subscription)
- **Memorystore Redis**: used by APIGW and ContentService (and others where configured)
- **Pub/Sub**: upload/event topics and StreamingService workers
- **GCS buckets**:
  - Upload bucket (raw assets uploaded directly by clients)
  - Streaming manifests bucket (HLS manifests/outputs)

All environment-specific values live in Kustomize overlays, e.g. `k8s/overlays/dev/patch-configmaps.yaml`.

### CI/CD on GitHub Actions (what runs)

Workflows:

- `.github/workflows/ci.yml`
  - Runs `npm ci` + `generate/lint/typecheck/test/build` per service folder on PRs and `main`
- `.github/workflows/deploy-gke.yml`
  - Auths to GCP via GitHub OIDC (Workload Identity Federation)
  - Builds + pushes Docker images to Artifact Registry
  - Deploys a chosen Kustomize overlay (`dev` by default; `staging`/`prod` via manual dispatch)
  - Waits for Kubernetes rollouts

Required GitHub Actions configuration (repo → Settings → Secrets and variables → Actions):

- **Secrets**
  - `GCP_WORKLOAD_IDENTITY_PROVIDER`
  - `GCP_SERVICE_ACCOUNT`
- **Variables**
  - `GCP_PROJECT_ID`
  - `GCP_REGION`
  - `GKE_CLUSTER`
  - `ARTIFACT_REPO`
  - `K8S_NAMESPACE` (used for default deploy target)

See `deploygcp.md` for the copy/paste values for the current GCP environment.

### How CDN, signed upload URLs, and signed playback URLs work (in this codebase)

There are three separate concerns:

1) **API traffic (APIGW)**
    - Served by GKE Ingress / Google Cloud Load Balancer.
    - Cloud CDN is typically **not** enabled for APIs.

2) **Uploads (client → GCS direct upload)**
    - Uploads are issued by UploadService using a **GCS V4 signed POST policy**.
    - Implementation: UploadService uses `@google-cloud/storage` and calls `generateSignedPostPolicyV4`.
    - Flow:
       - Client calls UploadService to request an upload intent.
       - UploadService returns `uploadUrl` + form `fields` (and an expiry).
       - Client uploads directly to GCS (browser/mobile multipart form POST).
    - Config:
       - `UPLOAD_BUCKET` controls the destination bucket.
       - `SIGNED_UPLOAD_TTL_SECONDS` controls policy expiry.

3) **Streaming playback (manifests over a CDN hostname)**
    - StreamingService exposes a “get manifest” flow that:
       - Introspects the viewer token against AuthService.
       - Checks entitlements/scopes.
       - Generates a **signed manifest URL** using an HMAC signature and returns it.
    - The returned URL is built from `CDN_BASE_URL` + the manifest path, with query params like:
       - `expires`, `session`, `keyId`, `sig`, `token` (HMAC-SHA256 over a canonicalized query string).
    - Important: signing a URL only protects content if your CDN/origin actually **enforces** the signature.
       - This repo currently implements the signing logic inside StreamingService.
       - Enforcement must happen at your CDN edge (or via an origin service/proxy) using the same signing secret.

If you want to use **GCP Cloud CDN** specifically:

- Cloud CDN usually sits in front of a backend bucket or backend service.
- Cloud CDN signed URLs/cookies have their own signing format; if you want Cloud CDN-native signing, you would adapt the StreamingService signer to match Cloud CDN’s expected query params.

As of today, the Kubernetes manifests in this repo do not create Cloud CDN resources; they configure URL bases (like `CDN_BASE_URL`) and implement signing inside services.

For a deeper deployment runbook (GKE, Workload Identity, secrets, DNS, TLS), use `deploygcp.md`.
