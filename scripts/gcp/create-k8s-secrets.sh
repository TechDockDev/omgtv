#!/usr/bin/env bash
set -euo pipefail

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required" >&2
  exit 1
fi

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl is required" >&2
  exit 1
fi

NAMESPACE="${1:-dev}"
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
SQL_INSTANCE="${SQL_INSTANCE:-pocketlol-pg}"

if [ -z "${PROJECT_ID:-}" ]; then
  echo "PROJECT_ID must be set (or gcloud default project configured)" >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT

get_secret_optional() {
  name="$1"
  default_value="${2:-}"

  if gcloud secrets describe "$name" --project "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud secrets versions access latest --project "$PROJECT_ID" --secret "$name" 2>/dev/null | tr -d '\n' || true
    return 0
  fi

  printf '%s' "$default_value"
}

echo "Using project: $PROJECT_ID"
echo "Using namespace: $NAMESPACE"

kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || kubectl create namespace "$NAMESPACE"

SERVICE_AUTH_TOKEN="$(gcloud secrets versions access latest --project "$PROJECT_ID" --secret service-auth-token | tr -d '\n')"
DB_USER="$(gcloud secrets versions access latest --project "$PROJECT_ID" --secret db-user | tr -d '\n')"
DB_PASS="$(gcloud secrets versions access latest --project "$PROJECT_ID" --secret db-password | tr -d '\n')"

FIREBASE_CREDENTIALS_B64="${FIREBASE_CREDENTIALS_B64:-$(get_secret_optional firebase-credentials-b64 "")}"

AUTH_SERVICE_INTERNAL_TOKEN="${AUTH_SERVICE_INTERNAL_TOKEN:-$(get_secret_optional streaming-auth-service-internal-token "$SERVICE_AUTH_TOKEN")}"

CLOUD_SQL_CONNECTION_NAME="${CLOUD_SQL_CONNECTION_NAME:-$(gcloud sql instances describe "$SQL_INSTANCE" --project "$PROJECT_ID" --format='value(connectionName)')}"

echo "Creating shared-secrets"
kubectl -n "$NAMESPACE" delete secret shared-secrets >/dev/null 2>&1 || true
kubectl -n "$NAMESPACE" create secret generic shared-secrets \
  --from-literal=SERVICE_AUTH_TOKEN="$SERVICE_AUTH_TOKEN"

echo "Creating cloudsql-secrets"
kubectl -n "$NAMESPACE" delete secret cloudsql-secrets >/dev/null 2>&1 || true
kubectl -n "$NAMESPACE" create secret generic cloudsql-secrets \
  --from-literal=CLOUD_SQL_CONNECTION_NAME="$CLOUD_SQL_CONNECTION_NAME"

mk_db_url() {
  db="$1"
  urlencode() {
    value="$1"

    if command -v python3 >/dev/null 2>&1; then
      python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$value"
      return 0
    fi

    if command -v python >/dev/null 2>&1; then
      python -c 'import sys
try:
  import urllib.parse as up
except Exception:
  import urllib as up
print(up.quote(sys.argv[1], safe=""))' "$value"
      return 0
    fi

    if command -v jq >/dev/null 2>&1; then
      printf '%s' "$value" | jq -sRr @uri
      return 0
    fi

    echo "Missing urlencode dependency (python3/python/jq). Install one or use a DB password without special characters." >&2
    exit 1
  }

  user_enc="$(urlencode "$DB_USER" | tr -d '\n')"
  pass_enc="$(urlencode "$DB_PASS" | tr -d '\n')"

  echo "postgresql://${user_enc}:${pass_enc}@127.0.0.1:5432/${db}?schema=public"
}

create_db_secret() {
  name="$1"
  db="$2"
  url="$(mk_db_url "$db")"

  kubectl -n "$NAMESPACE" delete secret "${name}" >/dev/null 2>&1 || true
  kubectl -n "$NAMESPACE" create secret generic "${name}" --from-literal=DATABASE_URL="$url"
}

echo "Creating DB secrets"
create_db_secret content-service-secrets pocketlol_content
create_db_secret upload-service-secrets pocketlol_upload
create_db_secret subscription-service-secrets pocketlol_subscription

echo "Creating user-service-secrets"
kubectl -n "$NAMESPACE" delete secret user-service-secrets >/dev/null 2>&1 || true
kubectl -n "$NAMESPACE" create secret generic user-service-secrets \
  --from-literal=DATABASE_URL="$(mk_db_url pocketlol_users)" \
  --from-literal=AUTH_SERVICE_TOKEN="$SERVICE_AUTH_TOKEN"

echo "Creating auth-service-secrets"
gcloud secrets versions access latest --project "$PROJECT_ID" --secret auth-jwt-private-key >"$tmpdir/auth_jwt_private.pem"
gcloud secrets versions access latest --project "$PROJECT_ID" --secret auth-jwt-public-key >"$tmpdir/auth_jwt_public.pem"

kubectl -n "$NAMESPACE" delete secret auth-service-secrets >/dev/null 2>&1 || true
kubectl -n "$NAMESPACE" create secret generic auth-service-secrets \
  --from-literal=DATABASE_URL="$(mk_db_url pocketlol_auth)" \
  --from-file=AUTH_JWT_PRIVATE_KEY="$tmpdir/auth_jwt_private.pem" \
  --from-file=AUTH_JWT_PUBLIC_KEY="$tmpdir/auth_jwt_public.pem" \
  --from-literal=USER_SERVICE_TOKEN="$SERVICE_AUTH_TOKEN" \
  --from-literal=FIREBASE_CREDENTIALS_B64="$FIREBASE_CREDENTIALS_B64"

echo "Creating streaming-service-secrets"
kubectl -n "$NAMESPACE" delete secret streaming-service-secrets >/dev/null 2>&1 || true
kubectl -n "$NAMESPACE" create secret generic streaming-service-secrets \
  --from-literal=CDN_SIGNING_SECRET="$(get_secret_optional streaming-cdn-signing-secret "development-secret")" \
  --from-literal=CDN_CONTROL_API_KEY="$(get_secret_optional streaming-cdn-control-api-key "")" \
  --from-literal=OME_API_KEY="$(get_secret_optional streaming-ome-api-key "local-key")" \
  --from-literal=OME_API_SECRET="$(get_secret_optional streaming-ome-api-secret "local-secret")" \
  --from-literal=METRICS_ACCESS_TOKEN="$(get_secret_optional streaming-metrics-access-token "")" \
  --from-literal=AUTH_SERVICE_INTERNAL_TOKEN="$AUTH_SERVICE_INTERNAL_TOKEN"

echo "Done. Next: fill ConfigMaps for Redis/GCS/PubSub and apply kustomize overlay."
