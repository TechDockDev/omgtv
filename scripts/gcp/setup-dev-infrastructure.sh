#!/bin/bash
# scripts/gcp/setup-dev-infrastructure.sh
# Create GCS bucket and Pub/Sub topics for DEVELOPMENT with -dev suffixes

PROJECT_ID="pocketlol-68ca6"
REGION="asia-south1"

echo "--- 1. Creating Unified DEV Bucket ---"
gsutil mb -p ${PROJECT_ID} -l ${REGION} -c STANDARD gs://videos-bucket-pocketlol-dev/ || echo "Bucket already exists"
gsutil iam ch allUsers:objectViewer gs://videos-bucket-pocketlol-dev/

echo "--- 2. Setting CORS for DEV Uploads ---"
cat > /tmp/cors-dev.json << 'EOF'
[
  {
    "origin": ["*"],
    "method": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "DELETE"],
    "responseHeader": ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Authorization", "x-goog-resumable"],
    "maxAgeSeconds": 86400
  }
]
EOF
gsutil cors set /tmp/cors-dev.json gs://videos-bucket-pocketlol-dev/

echo "--- 3. Creating Folder Structure ---"
# Creating placeholders to ensure folders show up in UI
touch .keep
gsutil cp .keep gs://videos-bucket-pocketlol-dev/videos/.keep
gsutil cp .keep gs://videos-bucket-pocketlol-dev/hls/.keep
gsutil cp .keep gs://videos-bucket-pocketlol-dev/images/.keep
gsutil cp .keep gs://videos-bucket-pocketlol-dev/thumbnail/.keep
rm .keep

echo "--- 4. Creating Isolated DEV Topics ---"
gcloud pubsub topics create transcoding-requests-dev --project=${PROJECT_ID} || echo "Topic already exists"
gcloud pubsub topics create uploaded-media-dev --project=${PROJECT_ID} || echo "Topic already exists"
gcloud pubsub topics create streaming-audit-dev --project=${PROJECT_ID} || echo "Topic already exists"
gcloud pubsub topics create media.preview.requested-dev --project=${PROJECT_ID} || echo "Topic already exists"
gcloud pubsub topics create media.processed-dev --project=${PROJECT_ID} || echo "Topic already exists"

echo "--- 5. Creating Isolated DEV Subscriptions ---"
gcloud pubsub subscriptions create transcoding-requests-sub-dev --topic=transcoding-requests-dev --project=${PROJECT_ID} --ack-deadline=600 || echo "Sub already exists"
gcloud pubsub subscriptions create streaming-audit-sub-dev --topic=streaming-audit-dev --project=${PROJECT_ID} --ack-deadline=30 || echo "Sub already exists"
gcloud pubsub subscriptions create uploaded-media-sub-dev --topic=uploaded-media-dev --project=${PROJECT_ID} --ack-deadline=60 || echo "Sub already exists"
gcloud pubsub subscriptions create content-media-uploaded-sub-dev --topic=uploaded-media-dev --project=${PROJECT_ID} --ack-deadline=10 || echo "Sub already exists"

echo ""
echo "=== Done! ==="
echo "DEV Unified Bucket: gs://videos-bucket-pocketlol-dev"
echo "Topics: transcoding-requests-dev, uploaded-media-dev, streaming-audit-dev, media.preview.requested-dev, media.processed-dev"
