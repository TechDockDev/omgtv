#!/usr/bin/env bash
# Tier-1 production monitoring: alert policies + uptime check via Cloud Monitoring.
# Usage: bash setup-monitoring.sh <ALERT_EMAIL> <PUBLIC_API_HOST>
#   e.g. bash setup-monitoring.sh ops@omgtv.in api.omgtv.in
#
# Creates (idempotence: re-running creates DUPLICATES — check the console first):
#   1. Email notification channel
#   2. Alert: Cloud SQL connections > 80 for 5 min
#   3. Alert: Cloud SQL CPU > 70% for 15 min
#   4. Log-based metric + alert: Prisma P2024 pool timeouts in prod namespace
#   5. Uptime check on https://<PUBLIC_API_HOST>/health + alert on failure
set -euo pipefail

ALERT_EMAIL="${1:?Usage: setup-monitoring.sh <ALERT_EMAIL> <PUBLIC_API_HOST>}"
API_HOST="${2:?Usage: setup-monitoring.sh <ALERT_EMAIL> <PUBLIC_API_HOST>}"
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
SQL_DATABASE_ID="${SQL_DATABASE_ID:-${PROJECT_ID}:pocketlol-pg-prod}"

echo "Project: $PROJECT_ID | Alerts to: $ALERT_EMAIL | Uptime host: $API_HOST"
tmpdir="$(mktemp -d)"; trap 'rm -rf "$tmpdir"' EXIT

# ── 1. Notification channel (reuse if one with this display name exists) ─────
CHANNEL=$(gcloud beta monitoring channels list \
  --filter="displayName=\"Ops Email ($ALERT_EMAIL)\"" \
  --project="$PROJECT_ID" \
  --format="value(name)" | head -1)
if [ -z "$CHANNEL" ]; then
  CHANNEL=$(gcloud beta monitoring channels create \
    --display-name="Ops Email ($ALERT_EMAIL)" \
    --type=email \
    --channel-labels="email_address=$ALERT_EMAIL" \
    --project="$PROJECT_ID" \
    --format="value(name)")
fi
echo "Notification channel: $CHANNEL"

# ── 2. Cloud SQL connection count ────────────────────────────────────────────
cat >"$tmpdir/sql-connections.json" <<EOF
{
  "displayName": "Cloud SQL prod: connections > 80",
  "combiner": "OR",
  "notificationChannels": ["$CHANNEL"],
  "documentation": {
    "mimeType": "text/markdown",
    "content": "Postgres connections on pocketlol-pg-prod are above 80 of 100. Prisma pools may be exceeding budget or an external client is hoarding. Runbook: check System Insights per-database breakdown; see scripts/gcp/create-k8s-secrets.sh for the per-service connection_limit budget."
  },
  "conditions": [{
    "displayName": "num_backends sum > 80 for 5m",
    "conditionThreshold": {
      "filter": "metric.type=\\"cloudsql.googleapis.com/database/postgresql/num_backends\\" resource.type=\\"cloudsql_database\\" resource.label.database_id=\\"$SQL_DATABASE_ID\\"",
      "aggregations": [{
        "alignmentPeriod": "60s",
        "perSeriesAligner": "ALIGN_MEAN",
        "crossSeriesReducer": "REDUCE_SUM"
      }],
      "comparison": "COMPARISON_GT",
      "thresholdValue": 80,
      "duration": "300s",
      "trigger": { "count": 1 }
    }
  }]
}
EOF
gcloud alpha monitoring policies create --policy-from-file="$tmpdir/sql-connections.json" --project="$PROJECT_ID"

# ── 3. Cloud SQL CPU ─────────────────────────────────────────────────────────
cat >"$tmpdir/sql-cpu.json" <<EOF
{
  "displayName": "Cloud SQL prod: CPU > 70%",
  "combiner": "OR",
  "notificationChannels": ["$CHANNEL"],
  "documentation": {
    "mimeType": "text/markdown",
    "content": "pocketlol-pg-prod CPU above 70% for 15 min. If sustained during normal traffic, plan tier upgrade (db-custom-2-8192). Check Query Insights for hot queries first (admin analytics are the usual suspects)."
  },
  "conditions": [{
    "displayName": "cpu utilization > 0.7 for 15m",
    "conditionThreshold": {
      "filter": "metric.type=\\"cloudsql.googleapis.com/database/cpu/utilization\\" resource.type=\\"cloudsql_database\\" resource.label.database_id=\\"$SQL_DATABASE_ID\\"",
      "aggregations": [{
        "alignmentPeriod": "60s",
        "perSeriesAligner": "ALIGN_MEAN"
      }],
      "comparison": "COMPARISON_GT",
      "thresholdValue": 0.7,
      "duration": "900s",
      "trigger": { "count": 1 }
    }
  }]
}
EOF
gcloud alpha monitoring policies create --policy-from-file="$tmpdir/sql-cpu.json" --project="$PROJECT_ID"

# ── 4. Prisma P2024 pool-timeout log metric + alert ──────────────────────────
gcloud logging metrics create prisma_pool_timeouts \
  --description="Prisma P2024: timed out waiting for a connection from the pool (prod namespace)" \
  --log-filter='resource.type="k8s_container" AND resource.labels.namespace_name="prod" AND "P2024"' \
  --project="$PROJECT_ID" || echo "log metric already exists, continuing"

cat >"$tmpdir/p2024.json" <<EOF
{
  "displayName": "Prod services: Prisma pool timeouts (P2024)",
  "combiner": "OR",
  "notificationChannels": ["$CHANNEL"],
  "documentation": {
    "mimeType": "text/markdown",
    "content": "A prod service logged Prisma P2024 (waited >30s for a DB connection). The service's connection_limit is saturated: either a query regression is holding connections or real load outgrew the budget. Next step: PgBouncer or DB tier bump — do not blindly raise connection_limit (budget: sum(limit x maxReplicas) < max_connections - 10)."
  },
  "conditions": [{
    "displayName": "any P2024 in 5m",
    "conditionThreshold": {
      "filter": "metric.type=\\"logging.googleapis.com/user/prisma_pool_timeouts\\" resource.type=\\"k8s_container\\"",
      "aggregations": [{
        "alignmentPeriod": "300s",
        "perSeriesAligner": "ALIGN_DELTA",
        "crossSeriesReducer": "REDUCE_SUM"
      }],
      "comparison": "COMPARISON_GT",
      "thresholdValue": 0,
      "duration": "0s",
      "trigger": { "count": 1 }
    }
  }]
}
EOF
gcloud alpha monitoring policies create --policy-from-file="$tmpdir/p2024.json" --project="$PROJECT_ID"

# ── 5. Uptime check on APIGW /health + alert ─────────────────────────────────
gcloud monitoring uptime create "apigw-health" \
  --resource-type=uptime-url \
  --resource-labels="host=$API_HOST,project_id=$PROJECT_ID" \
  --protocol=https \
  --path="/health/live" \
  --period=1 \
  --timeout=10 \
  --project="$PROJECT_ID" || echo "uptime check may already exist, continuing"

cat >"$tmpdir/uptime.json" <<EOF
{
  "displayName": "APIGW /health uptime failure",
  "combiner": "OR",
  "notificationChannels": ["$CHANNEL"],
  "documentation": {
    "mimeType": "text/markdown",
    "content": "External uptime check on https://$API_HOST/health/live is failing from multiple regions. The public API is down or unreachable. Check: kubectl get pods -n prod; ingress/load balancer status; Cloud SQL availability."
  },
  "conditions": [{
    "displayName": "uptime check failing",
    "conditionThreshold": {
      "filter": "metric.type=\\"monitoring.googleapis.com/uptime_check/check_passed\\" resource.type=\\"uptime_url\\" metric.label.check_id=\\"apigw-health\\"",
      "aggregations": [{
        "alignmentPeriod": "300s",
        "perSeriesAligner": "ALIGN_FRACTION_TRUE",
        "crossSeriesReducer": "REDUCE_MEAN"
      }],
      "comparison": "COMPARISON_LT",
      "thresholdValue": 0.5,
      "duration": "0s",
      "trigger": { "count": 1 }
    }
  }]
}
EOF
gcloud alpha monitoring policies create --policy-from-file="$tmpdir/uptime.json" --project="$PROJECT_ID"

# ── 6. Dashboard (config lives next to this script) ──────────────────────────
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$script_dir/monitoring-dashboard.json" ]; then
  gcloud monitoring dashboards create \
    --config-from-file="$script_dir/monitoring-dashboard.json" \
    --project="$PROJECT_ID" || echo "dashboard create failed (may already exist), continuing"
else
  echo "monitoring-dashboard.json not found next to script — skipping dashboard"
fi

echo ""
echo "Done. Verify in console: Monitoring -> Alerting (4 policies), Monitoring -> Uptime checks, Monitoring -> Dashboards ('OMGTV Prod - Backend Health')."
echo "Send a test: gcloud beta monitoring channels verify is not needed for email; trigger by temporarily lowering a threshold."
