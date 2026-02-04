# 🚀 OMGTV Production Load Testing Guide

**Target:** Validate 1 Lakh (100,000) DAU capacity  
**Stack:** k6 + Prometheus + Grafana  
**Environment:** GCP/GKE Production

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Infrastructure Setup](#infrastructure-setup)
3. [k6 + Prometheus + Grafana Integration](#observability-stack)
4. [Load Test Scripts](#load-test-scripts)
5. [Running the Tests](#running-tests)
6. [Interpreting Results](#interpreting-results)
7. [Dashboards](#dashboards)

---

## Overview

### Target Metrics for 1 Lakh DAU

| Metric | Target Value | How to Calculate |
|--------|--------------|------------------|
| **Peak Concurrent Users** | 5,000 - 10,000 | 5-10% of DAU |
| **Peak RPS** | 400 - 500 | 100K × 40 req ÷ (4 hrs × 3600) |
| **p95 Response Time** | < 300ms | 95th percentile |
| **Error Rate** | < 0.1% | Failed requests / Total |
| **CPU Usage** | < 70% | Under peak load |

### Testing Phases

```
Phase 1: Smoke Test (10 users)     → Find obvious bugs
Phase 2: Load Test (500 users)     → Test expected load
Phase 3: Stress Test (1000+ users) → Find breaking point
Phase 4: Soak Test (4+ hours)      → Find memory leaks
```

---

## Infrastructure Setup

### 1. Create Load Generator VM (GCP)

```bash
# Create a VM in the same region as your GKE cluster
gcloud compute instances create load-generator \
  --zone=asia-south1-a \
  --machine-type=e2-standard-4 \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud

# SSH into the VM
gcloud compute ssh load-generator --zone=asia-south1-a
```

### 2. Install k6 on Load Generator

```bash
# Install k6
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6

# Verify installation
k6 version
```

---

## Observability Stack

### Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│     k6      │────▶│ Prometheus  │────▶│   Grafana   │
│ Load Tests  │     │  (Metrics)  │     │ (Dashboard) │
└─────────────┘     └─────────────┘     └─────────────┘
       │                   ▲
       │                   │
       └───────────────────┘
         StatsD/Prometheus
         Remote Write
```

### 3. Deploy Prometheus + Grafana (Kubernetes)

Create `k8s/monitoring/prometheus-grafana.yaml`:

```yaml
# Prometheus Deployment
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-config
  namespace: monitoring
data:
  prometheus.yml: |
    global:
      scrape_interval: 15s
    scrape_configs:
      - job_name: 'k6'
        static_configs:
          - targets: ['k6-metrics:5656']
      - job_name: 'kubernetes-pods'
        kubernetes_sd_configs:
          - role: pod
        relabel_configs:
          - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
            action: keep
            regex: true
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prometheus
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: prometheus
  template:
    metadata:
      labels:
        app: prometheus
    spec:
      containers:
        - name: prometheus
          image: prom/prometheus:v2.45.0
          ports:
            - containerPort: 9090
          volumeMounts:
            - name: config
              mountPath: /etc/prometheus
      volumes:
        - name: config
          configMap:
            name: prometheus-config
---
apiVersion: v1
kind: Service
metadata:
  name: prometheus
  namespace: monitoring
spec:
  type: LoadBalancer
  ports:
    - port: 9090
  selector:
    app: prometheus
---
# Grafana Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: grafana
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: grafana
  template:
    metadata:
      labels:
        app: grafana
    spec:
      containers:
        - name: grafana
          image: grafana/grafana:10.0.0
          ports:
            - containerPort: 3000
          env:
            - name: GF_SECURITY_ADMIN_PASSWORD
              value: "admin123"
          volumeMounts:
            - name: grafana-storage
              mountPath: /var/lib/grafana
      volumes:
        - name: grafana-storage
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: grafana
  namespace: monitoring
spec:
  type: LoadBalancer
  ports:
    - port: 3000
  selector:
    app: grafana
```

Deploy:
```bash
kubectl create namespace monitoring
kubectl apply -f k8s/monitoring/prometheus-grafana.yaml
```

---

## Load Test Scripts

### 4. Production Load Test Script

Create `load-tests/production-load-test.js`:

```javascript
/**
 * OMGTV Production Load Test
 * Target: 500 RPS, 5000 concurrent users
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// Custom metrics for Prometheus
const errorRate = new Rate('error_rate');
const apiLatency = new Trend('api_latency');
const requestCount = new Counter('request_count');

export const options = {
  stages: [
    { duration: '2m', target: 100 },    // Warm up
    { duration: '5m', target: 500 },    // Ramp to 500
    { duration: '10m', target: 1000 },  // Ramp to 1000
    { duration: '10m', target: 2000 },  // Ramp to 2000
    { duration: '5m', target: 5000 },   // Peak load
    { duration: '5m', target: 5000 },   // Sustain peak
    { duration: '5m', target: 0 },      // Ramp down
  ],
  
  thresholds: {
    http_req_duration: ['p(95)<300', 'p(99)<500'],
    http_req_failed: ['rate<0.001'],  // 0.1% error rate
    error_rate: ['rate<0.001'],
  },
  
  // Output to Prometheus
  // Run with: k6 run --out experimental-prometheus-rw script.js
};

const BASE_URL = __ENV.BASE_URL || 'https://api.yourdomain.com';
let guestTokens = {};

function api(method, endpoint, body = null, token = null) {
  const url = `${BASE_URL}${endpoint}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const start = Date.now();
  let res;
  
  switch (method) {
    case 'GET':
      res = http.get(url, { headers, timeout: '30s' });
      break;
    case 'POST':
      res = http.post(url, body ? JSON.stringify(body) : null, { headers, timeout: '30s' });
      break;
  }
  
  apiLatency.add(Date.now() - start);
  requestCount.add(1);
  
  return res;
}

export default function () {
  const vuId = __VU;
  const deviceId = `prod-test-${vuId}-${Date.now()}`;

  // 1. Guest Auth
  group('auth', () => {
    const guest = api('POST', '/api/v1/auth/guest/init', {
      deviceId,
      deviceInfo: { platform: 'android', version: '2.0.0' },
    });
    
    if (check(guest, { 'guest auth ok': (r) => r.status === 200 })) {
      try {
        const data = JSON.parse(guest.body);
        guestTokens[vuId] = data.tokens?.accessToken;
      } catch (e) {}
    } else {
      errorRate.add(1);
    }
  });

  sleep(0.1);

  // 2. Home Feed (Most critical)
  group('home_feed', () => {
    const home = api('GET', '/api/v1/content/mobile/home');
    check(home, {
      'home feed ok': (r) => r.status === 200,
      'home feed fast': (r) => r.timings.duration < 300,
    }) || errorRate.add(1);
  });

  sleep(0.1);

  // 3. Search
  group('search', () => {
    const queries = ['drama', 'comedy', 'action', 'romance', 'thriller'];
    const q = queries[Math.floor(Math.random() * queries.length)];
    const search = api('GET', `/api/v1/search?q=${q}`);
    check(search, { 'search ok': (r) => r.status === 200 }) || errorRate.add(1);
  });

  sleep(0.1);

  // 4. Engagement (with auth)
  group('engagement', () => {
    const token = guestTokens[vuId];
    if (!token) return;

    const saved = api('GET', '/api/v1/engagement/series/saved', null, token);
    check(saved, { 'saved ok': (r) => r.status === 200 || r.status === 401 });
  });

  // Think time (realistic user behavior)
  sleep(Math.random() * 2 + 0.5);
}

export function handleSummary(data) {
  return {
    'summary.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}

import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
```

---

## Running Tests

### 5. Execute Load Test

```bash
# SSH to load generator VM
gcloud compute ssh load-generator --zone=asia-south1-a

# Copy test scripts
gcloud compute scp load-tests/*.js load-generator:~/load-tests/ --zone=asia-south1-a

# Run with Prometheus output
k6 run \
  --out experimental-prometheus-rw=http://PROMETHEUS_IP:9090/api/v1/write \
  -e BASE_URL=https://api.yourdomain.com \
  production-load-test.js

# Or run with JSON output
k6 run \
  --out json=results.json \
  -e BASE_URL=https://api.yourdomain.com \
  production-load-test.js
```

### Test Progression

| Day | Test Type | Users | Duration | Goal |
|-----|-----------|-------|----------|------|
| 1 | Smoke | 50 | 5 min | Verify setup works |
| 2 | Load | 500 | 30 min | Test expected load |
| 3 | Stress | 2000 | 30 min | Find limits |
| 4 | Peak | 5000 | 30 min | Validate 1L DAU |
| 5 | Soak | 1000 | 4 hours | Find memory leaks |

---

## Interpreting Results

### Success Criteria for 1 Lakh DAU

| Metric | Required | Your Result | Status |
|--------|----------|-------------|--------|
| Peak Users | 5,000 | ___ | ⬜ |
| RPS | 400-500 | ___ | ⬜ |
| p95 Latency | < 300ms | ___ | ⬜ |
| p99 Latency | < 500ms | ___ | ⬜ |
| Error Rate | < 0.1% | ___ | ⬜ |
| CPU Usage | < 70% | ___ | ⬜ |
| Memory | Stable | ___ | ⬜ |

### Red Flags to Watch

| Issue | Possible Cause | Fix |
|-------|----------------|-----|
| p95 > 500ms | N+1 queries, missing indexes | Optimize DB queries |
| Error rate > 1% | Connection pool exhausted | Increase pool size |
| Memory growing | Memory leak | Profile and fix code |
| CPU > 80% | Inefficient code | Scale horizontally |

---

## Dashboards

### 6. Grafana Dashboard Setup

1. **Access Grafana:** `http://GRAFANA_IP:3000` (admin/admin123)

2. **Add Prometheus Data Source:**
   - Settings → Data Sources → Add → Prometheus
   - URL: `http://prometheus:9090`

3. **Import k6 Dashboard:**
   - Dashboards → Import
   - Dashboard ID: `2587` (Official k6 Dashboard)
   - Or use ID: `10660` (k6 Load Testing Results)

### Key Panels to Monitor

| Panel | What to Watch |
|-------|---------------|
| **RPS** | Should reach 400-500 |
| **Response Time (p95)** | Must stay < 300ms |
| **Error Rate** | Must stay < 0.1% |
| **Active VUs** | Should reach 5000 |
| **Data Transfer** | Network throughput |

### Custom Dashboard JSON

Import this for OMGTV-specific metrics:

```json
{
  "title": "OMGTV Load Test Dashboard",
  "panels": [
    {
      "title": "Requests per Second",
      "type": "graph",
      "targets": [
        { "expr": "rate(k6_http_reqs_total[1m])" }
      ]
    },
    {
      "title": "Response Time (p95)",
      "type": "gauge",
      "targets": [
        { "expr": "histogram_quantile(0.95, k6_http_req_duration_seconds_bucket)" }
      ]
    },
    {
      "title": "Error Rate",
      "type": "stat",
      "targets": [
        { "expr": "rate(k6_http_req_failed_total[1m])" }
      ]
    }
  ]
}
```

---

## Quick Reference Commands

```bash
# Start load test with reporting
k6 run --out json=results.json production-load-test.js

# View real-time metrics
k6 run --out influxdb=http://localhost:8086/k6 production-load-test.js

# Scale specific service during test
kubectl scale deployment content-service --replicas=5

# Watch pod resources during test
kubectl top pods -w

# Check for OOM kills
kubectl get events --field-selector reason=OOMKilling
```

---

## Summary

| Phase | Action | Duration |
|-------|--------|----------|
| 1. Setup | Deploy monitoring stack | 1 day |
| 2. Smoke | Verify everything works | 1 hour |
| 3. Load | Test expected capacity | 1 day |
| 4. Stress | Find breaking points | 1 day |
| 5. Optimize | Fix bottlenecks | 2-3 days |
| 6. Validate | Confirm 1L DAU ready | 1 day |

**Total estimated time: 1 week**

---

*Guide prepared for OMGTV production load testing*
