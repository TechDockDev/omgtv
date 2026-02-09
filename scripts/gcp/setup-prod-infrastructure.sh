#!/bin/bash
# scripts/gcp/setup-prod-infrastructure.sh
# Create GCS buckets and Pub/Sub topics for PRODUCTION with -prod suffixes

PROJECT_ID="pocketlol-68ca6"
REGION="asia-south1"

echo "--- 1. Verifying Unified PROD Bucket (Existing) ---"
gsutil mb -p ${PROJECT_ID} -l ${REGION} -c STANDARD gs://videos-bucket-pocketlol/ || echo "Bucket already exists (Reusing)"
gsutil iam ch allUsers:objectViewer gs://videos-bucket-pocketlol/

echo "--- 2. Setting CORS for PROD (Bucket: videos-bucket-pocketlol) ---"
cat > /tmp/cors-prod.json << 'EOF'
[
  {
    "origin": ["*"],
    "method": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "DELETE"],
    "responseHeader": ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Authorization", "x-goog-resumable"],
    "maxAgeSeconds": 86400
  }
]
EOF
gsutil cors set /tmp/cors-prod.json gs://videos-bucket-pocketlol/

  --project=${PROJECT_ID} \
  --ack-deadline=30 || echo "Subscription may already exist"

echo ""
echo "=== Done! ==="
echo "Unified Bucket: gs://videos-bucket-pocketlol"
echo "Topics: transcoding-requests-prod, uploaded-media-prod, streaming-audit-prod"
