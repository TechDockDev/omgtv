# Operability Playbook

## 1. Validation Strategy

- **Static Analysis**: `npm run typecheck` and `npm run lint` gate pull requests for correctness and style.
- **Manual Smoke Checks**: Exercise key flows (auth, streaming, upload) against staging services after significant changes.
- **Performance Spot Checks**: Run ad-hoc k6 scenarios during major releases to confirm latency and rate-limit behaviour.
- **Security Reviews**: Periodic JWT tampering and replay simulations coordinated with the security team.

## 2. Observability Guide

- **Tracing**: Enable `ENABLE_TELEMETRY=true` with `OTEL_EXPORTER_OTLP_ENDPOINT` to stream spans. Expect inbound spans named `HTTP <verb> <route>` and child spans `proxy:<service>` produced by the shared HTTP utility.
- **Audit Events**: Turn on `ENABLE_AUDIT_EVENTS` and configure sink URL/token to capture `auth.failure` and `rate_limit.blocked` notifications. Gateway logs surface warnings when delivery fails.
- **Metrics**: Feed OTLP metrics from the collector into Prometheus/Grafana to monitor request latency, cache hit ratio, and downstream status codes. Add custom instruments as new KPIs emerge.
- **Logging**: Pino logger enriches every entry with `correlationId`. Preserve logs for at least 30 days and index by correlation ID for cross-system debugging.

### 2.1 Future Improvements

- Expand metrics coverage to include business counters (uploads, searches).
- Add automated span health checks in CI to ensure telemetry coverage remains above 95%.
- Introduce asynchronous sinks (Kafka/SQS) for audit events in regulated deployments.

## 3. Operational Runbooks

### 3.1 Rate Limit Spikes

1. Inspect Redis metrics for saturation or latency.
2. Check top offending IP/user IDs via gateway logs.
3. Adjust bucket sizes or block offending actors through CDN/WAF if attack.
4. Notify product and security teams if sustained abuse is observed.

### 3.2 Downstream Service Outage

1. Alert triggers from dependency error budget breach.
2. Engage owning service on-call; provide correlation IDs for failing requests.
3. Enable feature flag to short-circuit affected routes with friendly fallback (HTTP 503 + retry-after header).
4. Monitor recovery; disable fallback once stability verified.

### 3.3 JWT Verification Failures

1. Validate JWKS availability and freshness; clear local cache if stale.
2. Confirm Auth service signing key rotation schedule; ensure new keys distributed.
3. For systemic failures, disable strict mode and fall back to cached key for limited window per policy.

## 4. Logging & Audit

- Structured logs (JSON) emitted to stdout, aggregated via Fluent Bit/Vector.
- Include fields: timestamp, requestId, correlationId, userHash, routeId, upstreamService, statusCode, latencyMs, errorCode.
- Retain logs for 30 days in hot storage, archive for 12 months for compliance.
- Capture admin actions (config changes, feature flag toggles) with actor identity.

## 5. On-Call & Escalation

- Primary on-call rotation with 1-week shifts; backup on-call for redundancy.
- Escalation path: Gateway Engineer → Platform SRE → Security (if attack) → Product Lead.
- Incident severity matrix aligns with company standards (SEV1 production outage, SEV2 partial, etc.).
- Post-incident review within 48 hours documenting root cause, timeline, mitigating actions.

## 6. Tooling & Dashboards

- Grafana dashboards per environment with shared templates.
- Jaeger/Tempo UI for trace exploration; highlight downstream spans.
- Kibana/Datadog log views with saved filters for key routes and error categories.
- Alert manager integrated with Slack/PagerDuty for critical notifications.

## 7. Maintenance

- Quarterly dependency review; apply Fastify/Undici security patches promptly.
- Annual chaos engineering campaign to validate failover procedures.
- Regular review of rate-limit tiers based on usage analytics.
- Update documentation after each significant architecture or process change.
- Review `ROUTES_ENABLED`/`ROUTES_DISABLED` and `SERVICE_ENDPOINT_OVERRIDES` quarterly to prune stale toggles.
- Keep `.env.example` and internal runbooks updated when onboarding new upstream services.

## 8. Gateway Extension Workflow

1. **Prototype** – Implement schemas, proxy, and routes for the new service. Deploy to staging with `ROUTES_ENABLED=new-service`.
2. **Validate** – Run manual smoke tests plus trace/audit verification to ensure downstream spans and events emit as expected.
3. **Canary** – Enable the route in production for a subset of traffic. Use `SERVICE_ENDPOINT_OVERRIDES` to point to canary backends if downstream rollout is staggered.
4. **General Availability** – Remove overrides, update documentation, and monitor telemetry dashboards for regressions.
