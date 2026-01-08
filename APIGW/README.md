# PocketLOL API Gateway

This project delivers the production Fastify gateway that fronts every PocketLOL API request. The gateway centralizes authentication, rate limiting, routing, protocol mediation, and edge-friendly response shaping while remaining stateless and container-ready.

## Getting Started

1. Install dependencies:

 ```bash
 npm install
 ```

1. Copy `.env.example` to `.env` and customize values for your environment.
2. Run the TypeScript service in development mode:

 ```bash
 npm run dev
 ```

### Useful Scripts

- `npm run typecheck` – strict TypeScript validation with no emit.
- `npm run lint` – ESLint across the `src` tree.
- `npm run build` – compile the project to `dist/`.

## Configuration Highlights

- **Route toggles** – Use `ROUTES_ENABLED` or `ROUTES_DISABLED` to control which namespace plugins mount (`auth`, `content`, `videos`, `upload`, `engagement`, `search`).
- **Service overrides** – Supply `SERVICE_ENDPOINT_OVERRIDES` (e.g. `streaming=https://streaming-canary.internal`) for blue/green or canary routing without code changes.
- **Audit events** – Enable `ENABLE_AUDIT_EVENTS` and provide `AUDIT_EVENT_SINK_URL` (plus optional token) to forward auth failures and rate-limit breaches to your compliance system.
- **Telemetry** – Flip `ENABLE_TELEMETRY=true` and configure `OTEL_EXPORTER_OTLP_ENDPOINT` to stream spans and metrics to your collector.

### Environment Variable Ownership

Refer to [.env.example](.env.example) for the complete list. Ownership is split as follows:

- **Gateway platform team** – Runtime/server tuning, logging switches, Redis URL, rate-limit tiers, cache TTLs, route toggles, and service overrides.
- **Service owners** – Downstream service URLs and optional `SERVICE_AUTH_TOKEN` when private networks require service-to-service auth.
- **Auth** – JWT configuration (`AUTH_JWKS_URL`, `AUTH_AUDIENCE`, `AUTH_ISSUER`, `AUTH_CACHE_TTL_SECONDS`).
- **Observability** – Telemetry settings (`SERVICE_NAME`, `ENABLE_TELEMETRY`, `OTEL_EXPORTER_OTLP_ENDPOINT`) and any collector credentials.
- **Security/Compliance** – Audit sink parameters (`ENABLE_AUDIT_EVENTS`, `AUDIT_EVENT_SINK_URL`, `AUDIT_EVENT_SINK_TOKEN`, `AUDIT_EVENT_SINK_TIMEOUT_MS`).

## Containerization

Use the root-level Docker Compose workflow to launch the gateway together with Redis, AuthService, UserService, and PostgreSQL:

```bash
docker compose up --build api-gateway
```

The compose file exposes the gateway on port `3000`. See [../README.md](../README.md) for full-stack details.

## Documentation

- [Architecture Blueprint](docs/api-gateway-architecture.md)
- [Deployment & Operations](docs/deployment-plan.md)
- [Operability Playbook](docs/operability.md)
