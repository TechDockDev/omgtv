#!/bin/bash
set -euo pipefail

# USAGE: ./scripts/generate-dev-env.sh [NAMESPACE]
# Example: ./scripts/generate-dev-env.sh dev

NAMESPACE="${1:-dev}"
OUTPUT_FILE=".env.dev"

echo "Generating $OUTPUT_FILE from Kubernetes namespace '$NAMESPACE'..."

# Function to get secret value
get_secret() {
    local secret_name=$1
    local key=$2
    kubectl get secret "$secret_name" -n "$NAMESPACE" -o jsonpath="{.data.$key}" 2>/dev/null | base64 -d || echo ""
}

# Function to get configmap value
get_config() {
    local cm_name=$1
    local key=$2
    kubectl get configmap "$cm_name" -n "$NAMESPACE" -o jsonpath="{.data.$key}" 2>/dev/null || echo ""
}

# --- EXTRACT VARIABLES ---

echo "Fetching secrets..."

# Shared
SERVICE_AUTH_TOKEN=$(get_secret shared-secrets SERVICE_AUTH_TOKEN)

# DB Credentials (from cloudsql-secrets or individual service secrets)
# We need to parse the DATABASE_URL to get User/Pass for the proxy
# Format: postgresql://USER:PASS@...
# A cheat is to grab them from the 'db-user' and 'db-password' secrets if they exist in the project, 
# BUT k8s secrets might be the only source. 
# Let's try to parse one of the DB URLs, e.g., auth-service.
AUTH_DB_URL=$(get_secret auth-service-secrets DATABASE_URL)
# Regex to extract user:pass. minimal effort:
# Split by : and @
# postgresql://[user]:[pass]@[host]:[port]/[db]
DB_USER=$(echo "$AUTH_DB_URL" | sed -E 's|postgresql://([^:]+):([^@]+)@.*|\1|')
DB_PASS=$(echo "$AUTH_DB_URL" | sed -E 's|postgresql://([^:]+):([^@]+)@.*|\2|')

# Auth Service
AUTH_JWT_PRIVATE_KEY=$(get_secret auth-service-secrets AUTH_JWT_PRIVATE_KEY)
AUTH_JWT_PUBLIC_KEY=$(get_secret auth-service-secrets AUTH_JWT_PUBLIC_KEY)
# Key ID is in ConfigMap
AUTH_JWT_KEY_ID=$(get_config auth-service-config AUTH_JWT_KEY_ID)
FIREBASE_PROJECT_ID=$(get_config auth-service-config FIREBASE_PROJECT_ID)
FIREBASE_CREDENTIALS_B64=$(get_secret auth-service-secrets FIREBASE_CREDENTIALS_B64)

# Meilisearch
MEILI_MASTER_KEY=$(get_secret meilisearch-secrets MEILI_MASTER_KEY)

# Subscription
RAZORPAY_KEY_ID=$(get_config subscription-service-config RAZORPAY_KEY_ID)
RAZORPAY_KEY_SECRET=$(get_config subscription-service-config RAZORPAY_KEY_SECRET)

# GCP / Uploads
GCP_PROJECT_ID=$(get_config upload-service-config GCP_PROJECT_ID)
UPLOAD_BUCKET=$(get_config upload-service-config UPLOAD_BUCKET)
# CDN
CDN_BASE_URL=$(get_config content-service-config CDN_BASE_URL)

# --- WRITE TO FILE ---

cat > "$OUTPUT_FILE" <<EOF
# Generated for DEV VM on $(date)

# --- DATABASE (Cloud SQL Proxy) ---
DB_USER=$DB_USER
DB_PASS=$DB_PASS
# Note: Host is always 127.0.0.1 because of the proxy in docker-compose
DB_HOST=127.0.0.1
CLOUD_SQL_CONNECTION_NAME=pocketlol-68ca6:asia-south1:pocketlol-pg

# --- REDIS (External) ---
REDIS_URL=redis://10.117.209.35:6379

# --- SHARED ---
SERVICE_AUTH_TOKEN=$SERVICE_AUTH_TOKEN
GCP_PROJECT_ID=${GCP_PROJECT_ID:-pocketlol-68ca6}

# --- AUTH SERVICE ---
AUTH_JWT_KEY_ID=$AUTH_JWT_KEY_ID
AUTH_JWT_PRIVATE_KEY="$AUTH_JWT_PRIVATE_KEY"
AUTH_JWT_PUBLIC_KEY="$AUTH_JWT_PUBLIC_KEY"
FIREBASE_PROJECT_ID=$FIREBASE_PROJECT_ID
FIREBASE_CREDENTIALS_B64=$FIREBASE_CREDENTIALS_B64

# --- MEILISEARCH ---
MEILI_MASTER_KEY=${MEILI_MASTER_KEY:-masterKey}

# --- UPLOAD & STORAGE ---
UPLOAD_BUCKET=$UPLOAD_BUCKET
CDN_BASE_URL=$CDN_BASE_URL

# --- SUBSCRIPTION ---
RAZORPAY_KEY_ID=$RAZORPAY_KEY_ID
RAZORPAY_KEY_SECRET=$RAZORPAY_KEY_SECRET

EOF

echo "Done! Secrets saved to $OUTPUT_FILE"
echo "Next step: Copy this file to your VM:"
echo "  scp $OUTPUT_FILE USER@VM_IP:/home/USER/.env"
