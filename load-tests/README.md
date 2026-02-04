# OMGTV Load Testing Suite

Local load testing for bug catching and API stability verification.

## Prerequisites

```powershell
# Install k6
winget install k6
```

## Quick Start

```powershell
# 1. Start all services
cd d:\nodejs\omgtv
docker-compose up -d

# 2. Wait for services to be healthy (all should show "healthy")
docker-compose ps

# 3. Run smoke test first
cd load-tests
k6 run smoke-test.js

# 4. If smoke test passes, run load test
k6 run load-test.js
```

## Test Phases

| Phase | Script | Users | Duration | Purpose |
|-------|--------|-------|----------|---------|
| 1. Smoke | `smoke-test.js` | 10-20 | 3 min | Catch crashes, verify basic stability |
| 2. Load | `load-test.js` | 50 | 5 min | Test sustained load locally |

## Success Criteria

- ✅ **Smoke Test**: 0 errors, all health checks pass
- ✅ **Load Test**: p95 < 300ms, error rate < 1%

## What to Do if Tests Fail

### Health checks fail
```powershell
docker-compose logs api-gateway
docker-compose logs content-service
```

### High error rate
1. Check service logs for stack traces
2. Look for N+1 query patterns
3. Check Redis/Postgres connection issues

### Slow responses (p95 > 500ms)
1. Check database query times
2. Look for missing indexes
3. Check Redis cache hit rates

## Environment Variables

```powershell
# Test against different URL
$env:BASE_URL="http://localhost:3000" ; k6 run smoke-test.js
```

## Files

- `smoke-test.js` - Phase 1: Light load, basic health
- `load-test.js` - Phase 2: Medium load, user sessions
- `config.js` - Shared configuration

---

> ⚠️ **Important**: Local tests find bugs, NOT production capacity. For real load testing, use a separate VM pointing at staging/production.
