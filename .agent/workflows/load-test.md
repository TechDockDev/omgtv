---
description: Run local load tests to catch bugs and verify API stability
---

# Local Load Testing Workflow

## Prerequisites
// turbo
1. Ensure k6 is installed:
```powershell
winget install k6
```

## Phase 1: Smoke Test (Run First)

// turbo
2. Start all Docker services:
```powershell
docker-compose up -d
```

// turbo
3. Wait for healthy status:
```powershell
docker-compose ps
```

// turbo
4. Run smoke test:
```powershell
cd load-tests && k6 run smoke-test.js
```

**Success Criteria:**
- All health checks pass
- Error rate: 0%
- No crashes in Docker logs

## Phase 2: Load Test (Only After Smoke Passes)

// turbo
5. Run load test:
```powershell
cd load-tests && k6 run load-test.js
```

**Success Criteria:**
- p95 latency < 300ms
- Error rate < 1%
- No memory leaks

## Troubleshooting

If tests fail, check logs:
```powershell
docker-compose logs --tail=100 api-gateway
docker-compose logs --tail=100 content-service
```

## Environment Variables

Test against different URL:
```powershell
$env:BASE_URL="http://localhost:3000"; k6 run smoke-test.js
```
