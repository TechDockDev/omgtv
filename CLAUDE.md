# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Commands

All services share the same script surface. Run from inside the service directory:

```bash
npm run dev           # tsx watch (hot reload)
npm run build         # tsc → dist/
npm start             # node dist/server.js
npm run typecheck     # tsc --noEmit (no emit, strict check)
npm run lint          # eslint src/**/*.ts
npm run format        # prettier --write .
npm run generate      # prisma generate (Prisma services only)
npm run migrate:dev   # prisma migrate dev (local schema changes)
npm run migrate:deploy # prisma migrate deploy (production)
```

Full stack (from repo root):
```bash
docker compose --env-file .env up --build              # Start everything
docker compose --env-file .env down --volumes          # Tear down + wipe DBs
```

Services with tests: `ContentService` (vitest), `APIGW`, `EngagementService` — run with `npm test`.

---

## Services & Ports

| Service | HTTP | gRPC | Purpose |
|---|---|---|---|
| APIGW | 3000 | — | Public gateway, JWT validation, rate limiting, proxying |
| AuthService | 4000 | 50051 | Login/register, JWT issuance (RSA RS256), session management |
| UserService | 4500 | 50052 | RBAC — roles, permissions, user profile metadata |
| ContentService | 4600 | — | Series/episodes/reels catalog, Redis-cached feeds |
| EngagementService | 4700 | — | Likes, saves, view progress, reviews, app analytics |
| SearchService | 4800 | — | Full-text search via Meilisearch |
| StreamingService | 4900 | — | HLS manifests, signed CDN playback URLs |
| UploadService | 5000 | — | GCS signed upload policies, transcoding dispatch |
| SubscriptionService | 5100 | 50071 | Razorpay billing, coin wallet, entitlement checks |
| NotificationService | 5200 | 50072 | Push (FCM), email (SMTP), in-app notification log |
| TranscodingWorker | — | — | Pub/Sub consumer — FFmpeg HLS ABR transcoding |

---

## Architecture

### Request Flow

```
Mobile/Web → APIGW (3000)
  ├── Validates JWT against AuthService JWKS (/.well-known/jwks.json)
  ├── Enriches request with x-user-id, x-user-roles, x-user-permissions headers
  └── Proxies via @fastify/reply-from to downstream services
```

Downstream services trust the headers injected by APIGW — they do **not** re-validate JWTs themselves. Admin endpoints check `x-user-roles` / `x-user-permissions`. Internal endpoints (`/internal/*`) check `x-service-token` header against `SERVICE_AUTH_TOKEN`.

### Service-to-Service Communication

Three patterns are used:

1. **gRPC** (hot path — token validation, user context lookup):
   - AuthService → UserService: enrich JWT claims with RBAC context at login
   - APIGW → AuthService: `ValidateToken` on every request
   - SubscriptionService → AuthService/UserService: entitlement checks
   - All gRPC calls carry `authorization: Bearer ${SERVICE_AUTH_TOKEN}` in metadata

2. **HTTP REST** (service-to-service, non-critical path):
   - Pattern: each service has a `src/clients/<name>-client.ts` that wraps `fetch` with service token header
   - E.g. `ContentClient` in SubscriptionService, `NotificationClient` in SubscriptionService

3. **GCP Pub/Sub** (async, fire-and-forget):
   - `media.uploaded` → TranscodingWorker subscribes → publishes `streaming-audit` on completion
   - `streaming-audit` → ContentService subscribes → marks media as ready
   - `user.registered` → NotificationService subscribes → sends welcome email

### Auth & RBAC

JWT claims are set by AuthService at login time by calling UserService gRPC `GetUserContext`. The enriched claims include `roles` and `permissions` arrays.

UserService is the source of truth for RBAC:
- `Role` → `RolePermission` → `Permission` (resource + action pairs, e.g. `content:write`, `users:read`)
- `UserRoleAssignment` links a userId to a role with optional scope and audit metadata
- System roles: `SUPER_ADMIN`, `ADMIN`, `RIA`, `FINANCIAL_TEAM`

APIGW enforces access via middleware that reads `x-user-permissions` — no service re-implements permission logic.

### Database Isolation

Each service owns its own PostgreSQL database. They never share tables or query each other's DB directly. Cross-service data needs go through the HTTP/gRPC API of the owning service.

| Service | Database |
|---|---|
| AuthService | `pocketlol_auth` |
| UserService | `pocketlol_users` |
| ContentService | `pocketlol_content` |
| EngagementService | `pocketlol_engagement` |
| UploadService | `pocketlol_uploads` |
| SubscriptionService | `pocketlol_subscription` |
| NotificationService | `pocketlol_notification` |

### Key Shared Patterns

**Config**: Every service has `src/config/index.ts` (or `src/config.ts`) with a Zod schema that validates env vars on startup and throws with a clear message if required vars are missing. Always call `loadConfig()` — never read `process.env` directly.

**Prisma**: Accessed via a singleton in `src/lib/prisma.ts` (or `src/prisma.ts`). Use the singleton — don't instantiate `PrismaClient` elsewhere.

**Service token auth**: `/internal/*` routes are automatically guarded by `src/plugins/service-auth.ts` which checks `x-service-token` or `Authorization: Bearer` against `SERVICE_AUTH_TOKEN`. No additional auth hook needed on internal routes.

**Non-fatal external calls**: Calls to NotificationService, external analytics, etc. must never throw into the caller's transaction. Wrap in try/catch and log — the `NotificationClient.sendPush()` already does this.

**Push notifications**: SubscriptionService calls NotificationService at `POST /internal/push/send` after payment events. The internal-push route logs each send to the `notification` table with `status: SENT | FAILED` and the trigger `type` in the `data` JSON field (`SUBSCRIPTION_ACTIVATED`, `SUBSCRIPTION_RENEWED`, `SUBSCRIPTION_PAYMENT_FAILED`, `COIN_PURCHASE_SUCCESS`, `COIN_PURCHASE_FAILED`).

### Payment Flow (Razorpay)

Two paths for credit/activation — both must be handled:

1. **App calls `/purchase/verify`** (normal flow): signature validated, subscription created, notification sent here. Subsequent webhook is deduplicated by `existingTx` paymentId check.
2. **Webhook fires first** (`subscription.charged`, `payment.captured`): creates subscription, sends notification. Subsequent verify call sees existing record and skips.

Never add notification calls only to webhooks — the verify endpoint is the primary path for the app.

---

## Proto Files

gRPC service definitions live in `{Service}/proto/*.proto`. After editing a `.proto`, regenerate the TypeScript types:

```bash
npm run proto:gen   # (where defined — check package.json scripts)
```

AuthService and UserService protos are consumed by APIGW and SubscriptionService — changes are cross-cutting.
