# Deployment & Operations Plan

## 1. Environments

| Stage     | Purpose                                   | Key Configurations                           |
|-----------|-------------------------------------------|----------------------------------------------|
| Local     | Developer laptops via Docker Compose      | Hot reload, stub services, local Redis.      |
| Dev       | Shared integration cluster                | Feature branches, synthetic data, debug logs.|
| Staging   | Pre-production, load and chaos testing    | Production-like sizing, canary rehearsals.   |
| Production| Customer-facing workloads                 | Multi-AZ, autoscaling enabled, observability tuned. |

## 2. Build & CI/CD Pipeline

1. `npm ci` with Node.js 20 LTS for deterministic installs.
2. Run static analysis gates: `npm run typecheck`, `npm run lint`, and vulnerability scans (npm audit, Snyk).
3. Compile TypeScript to `dist/` and execute lightweight smoke script or Fastify `ready` check against the bundle.
4. Build Docker image with multi-stage Dockerfile (builder + runtime).
5. Push artifact to container registry (ECR, GCR, Artifactory).
6. Trigger infrastructure deploy via GitOps or pipeline (ArgoCD, Spinnaker, Harness).

### Promotion Strategy

- Use trunk-based development with short-lived feature branches.
- Staging deployments require automated regression suite + manual approval.
- Production deployments follow blue/green or canary release strategy.

## 3. Infrastructure Topology

- **Compute**: Kubernetes deployment with HPA (CPU + request latency metrics) or ECS Fargate service.
- **Networking**: Private subnets for gateway pods; public entry via CDN + LB.
- **Redis**: Managed service (Elasticache/MemoryStore) in same region with TLS.
- **Secrets**: AWS Secrets Manager/GCP Secret Manager mounted via sidecar or environment injection.
- **Certificate Management**: TLS terminated at CDN and re-encrypted to gateway using managed ACM certificates.

## 4. Configuration Management

- Base configuration stored in version control; environment overrides via `.env` templates.
- Leverage SSM Parameter Store or ConfigMap (Kubernetes) for non-secret values.
- Use runtime feature flags (LaunchDarkly / Unleash) for progressive rollout of new routes.

## 5. Deployment Mechanics

### Kubernetes Example

1. Apply ConfigMaps/Secrets for environment variables, JWKS URLs, upstream endpoints.
2. Deploy Redis connection secret (connection string, password).
3. Apply Deployment manifest with readiness/liveness probes (HTTP `/health/live`, `/health/ready`).
4. Configure HPA with targets: CPU 60%, p95 latency < 200ms.
5. Expose service via ClusterIP; map to Ingress/Service mesh virtual service.

### Rollout Strategy

- Use progressive `maxSurge=1`/`maxUnavailable=0` for zero-downtime upgrades.
- Canary: deploy new version to 5% of traffic via weighted Ingress/Service mesh rule.
- Observe metrics/logs for 15 minutes; promote to 100% if healthy.

## 6. Observability & Alerting

- OpenTelemetry traces/metrics export via OTLP. Configure `ENABLE_TELEMETRY=true`, `SERVICE_NAME`, and `OTEL_EXPORTER_OTLP_ENDPOINT` in environment, plus collector credentials where required.
- Audit sink integration optional per environment. Provide `ENABLE_AUDIT_EVENTS`, `AUDIT_EVENT_SINK_URL`, and `AUDIT_EVENT_SINK_TOKEN` to forward compliance events on auth failures or rate-limit breaches.
- Define alert rules:
- Define alert rules:
  - Error rate > 5% for 5 minutes.
  - Rate limit rejections spike beyond baseline.
  - Redis latency > 50ms p95.
  - gRPC call failure rate > threshold per service.
- Dashboards: request throughput, latency heatmap, cache hit ratio, dependency health.

## 7. Disaster Recovery & Resilience

- Multi-AZ deployment by default; replicate Redis with automatic failover and monitor Redis latency metrics emitted by OpenTelemetry.
- Back up configuration and deployment manifests in Git.
- Document runbook for region failover: warm standby in secondary region with DNS weight shift.
- Implement circuit breakers (opossum/resilient) for downstream dependencies; fallback to graceful degradation responses.

## 8. Runtime Operations

- Weekly chaos drill (latency injection, dependency outage) in staging.
- Monthly dependency upgrade cycle (Node.js patch, Fastify plugins).
- Automate scaling tests quarterly to validate capacity assumptions.
- Maintain on-call rotation with defined escalation paths and response SLAs.

## 9. Compliance & Security

- Apply image signing (Cosign) and enforce admission policy for verified images.
- Run container vulnerability scans during CI and in registry (Trivy/Clair).
- Enable WAF rules at CDN for OWASP Top 10 protections.
- Maintain audit logs for admin API usage and configuration changes.
- Maintain audit logs for admin API usage and configuration changes. Ensure audit sink endpoint archives events per regulatory requirements.

## 10. Success Metrics

- Availability (SLO): 99.95% monthly.
- Latency: p95 < 150ms for lightweight routes, < 300ms for proxy routes.
- Error Budget: 21.6 minutes downtime per month.
- Rate-limit accuracy: < 1% false positives.
- Deployment MTTR: < 30 minutes.
- Deployment MTTR: < 30 minutes.
- Telemetry Coverage: 95% of production traffic with trace + audit signals.
