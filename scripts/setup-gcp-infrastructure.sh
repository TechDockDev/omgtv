#!/bin/bash
# Create GCS buckets and Pub/Sub topics using gcloud CLI
# Alternative to Terraform when Terraform is not installed

PROJECT_ID="pocketlol-68ca6"
REGION="asia-south1"

echo "=== Creating GCS Buckets ==="

# Create uploads bucket
gsutil mb -p ${PROJECT_ID} -l ${REGION} -c STANDARD gs://${PROJECT_ID}-uploads/ || echo "Bucket may already exist"

# Create streaming bucket  
gsutil mb -p ${PROJECT_ID} -l ${REGION} -c STANDARD gs://${PROJECT_ID}-streaming/ || echo "Bucket may already exist"

# Make streaming bucket publicly accessible for CDN
gsutil iam ch allUsers:objectViewer gs://${PROJECT_ID}-streaming/

# Set CORS on streaming bucket
cat > /tmp/cors.json << 'EOF'
[
  {
    "origin": ["*"],
    "method": ["GET", "HEAD", "OPTIONS"],
    "responseHeader": ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"],
    "maxAgeSeconds": 86400
  }
]
EOF
gsutil cors set /tmp/cors.json gs://${PROJECT_ID}-streaming/

echo ""
echo "=== Creating Pub/Sub Topics ==="

# Create topics
gcloud pubsub topics create media.uploaded --project=${PROJECT_ID} || echo "Topic may already exist"
gcloud pubsub topics create media.ready --project=${PROJECT_ID} || echo "Topic may already exist"
gcloud pubsub topics create media.uploaded-dlq --project=${PROJECT_ID} || echo "DLQ topic may already exist"

echo ""
echo "=== Creating Pub/Sub Subscriptions ==="

# Create subscription for TranscodingWorker
gcloud pubsub subscriptions create media.uploaded-sub \
  --topic=media.uploaded \
  --project=${PROJECT_ID} \
  --ack-deadline=600 \
  --min-retry-delay=10s \
  --max-retry-delay=600s || echo "Subscription may already exist"

# Create subscription for UploadService callback
gcloud pubsub subscriptions create media.ready-sub \
  --topic=media.ready \
  --project=${PROJECT_ID} \
  --ack-deadline=30 || echo "Subscription may already exist"

echo ""
echo "=== Done! ==="
echo "Uploads bucket: gs://${PROJECT_ID}-uploads"
echo "Streaming bucket: gs://${PROJECT_ID}-streaming"
echo "Topics: media.uploaded, media.ready"
echo "Subscriptions: media.uploaded-sub, media.ready-sub"
