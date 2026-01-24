#!/bin/bash
# Setup script for TranscodingWorker GCP credentials
# Run these commands in your terminal

PROJECT_ID="pocketlol-68ca6"
SERVICE_ACCOUNT="pocketlol-workload@${PROJECT_ID}.iam.gserviceaccount.com"

echo "=== Step 1: Create service account key ==="
gcloud iam service-accounts keys create ./secrets/gcp-service-account.json \
  --iam-account=${SERVICE_ACCOUNT} \
  --project=${PROJECT_ID}

echo ""
echo "=== Step 2: Grant Storage permissions ==="
# Upload bucket - read access
gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/storage.objectViewer" \
  --condition=None

# Streaming bucket - write access  
gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/storage.objectAdmin" \
  --condition=None

echo ""
echo "=== Step 3: Grant Pub/Sub permissions ==="
# Subscriber (to read media.uploaded)
gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/pubsub.subscriber" \
  --condition=None

# Publisher (to write media.ready)
gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/pubsub.publisher" \
  --condition=None

echo ""
echo "=== Done! Key saved to secrets/gcp-service-account.json ==="
