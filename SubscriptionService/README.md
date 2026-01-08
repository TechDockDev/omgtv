# Subscription Service (PocketLOL)

Admin-driven subscription and billing service following existing PocketLOL Fastify/Prisma conventions. Handles plan management, free plan rules, user subscriptions, Razorpay payment tracking, and entitlement validation for downstream services.

## Local Development

1. Copy `.env.example` to `.env` and fill values (DATABASE_URL, REDIS_URL, Razorpay keys, SERVICE_AUTH_TOKEN).
2. Install deps: `npm ci`.
3. Generate Prisma client: `npm run generate`.
4. Start dev server: `npm run dev` (HTTP on `:4700`).

## HTTP Surface (v1)

- Admin: `/api/v1/subscription/admin/*` (plan CRUD, free plan config, transactions, user subscriptions).
- Customer: `/api/v1/subscription/*` (list plans, purchase intent, current subscription, transaction history).
- Internal: `/internal/*` (entitlement checks) protected by `SERVICE_AUTH_TOKEN`.

## Notes

- Prisma schema lives in `prisma/schema.prisma`; migrations will be added per Phase 1 of `tasks.md`.
- gRPC contract stubbed in `proto/subscription.proto` for entitlement queries.
- Observability hooks use OTLP exporters when configured; otherwise they remain no-ops.
