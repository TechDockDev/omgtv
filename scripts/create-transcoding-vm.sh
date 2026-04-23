#!/usr/bin/env bash
# Run this ONCE from GCP Cloud Shell.
# Creates the service account, grants IAM roles, generates a deploy SSH key,
# reserves a static IP, and provisions the production transcoding Spot VM.
set -euo pipefail

PROJECT="pocketlol-68ca6"
ZONE="asia-south1-a"
REGION="asia-south1"
SA_NAME="transcoding-worker-sa"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
VM_NAME="transcoding-worker-prod"
STATIC_IP_NAME="transcoding-worker-ip"
SSH_KEY_FILE="$HOME/.ssh/transcoding-worker-deploy"
STARTUP_SCRIPT="/tmp/transcoding-startup.sh"

# ======================================================
# STEP 1: Service Account + IAM
# ======================================================
echo "==> Creating service account..."
if gcloud iam service-accounts describe "${SA_EMAIL}" --project="${PROJECT}" > /dev/null 2>&1; then
  echo "    Service account already exists, skipping."
else
  gcloud iam service-accounts create "${SA_NAME}" \
      --display-name="Transcoding Worker" \
      --project="${PROJECT}"
fi

echo "==> Granting IAM roles..."
gcloud projects add-iam-policy-binding "${PROJECT}" \
    --member="serviceAccount:${SA_EMAIL}" --role="roles/storage.objectAdmin"

gcloud projects add-iam-policy-binding "${PROJECT}" \
    --member="serviceAccount:${SA_EMAIL}" --role="roles/pubsub.editor"

gcloud projects add-iam-policy-binding "${PROJECT}" \
    --member="serviceAccount:${SA_EMAIL}" --role="roles/cloudsql.client"

gcloud projects add-iam-policy-binding "${PROJECT}" \
    --member="serviceAccount:${SA_EMAIL}" --role="roles/artifactregistry.reader"

echo "==> Service account ready: ${SA_EMAIL}"

# ======================================================
# STEP 2: Generate SSH Key for GitHub Actions
# ======================================================
echo "==> Generating deploy SSH key pair..."
if [ -f "${SSH_KEY_FILE}" ]; then
  echo "    SSH key already exists at ${SSH_KEY_FILE}, reusing it."
else
  ssh-keygen -t ed25519 -f "${SSH_KEY_FILE}" -N "" -C "github-actions-transcoding-deploy"
fi

PUBLIC_KEY="ubuntu:$(cat "${SSH_KEY_FILE}.pub")"
PRIVATE_KEY=$(cat "${SSH_KEY_FILE}")

echo "==> SSH key ready."

# ======================================================
# STEP 3: Reserve Static External IP (skip if already exists)
# ======================================================
echo "==> Reserving static IP (${STATIC_IP_NAME})..."
if gcloud compute addresses describe "${STATIC_IP_NAME}" --region="${REGION}" --project="${PROJECT}" > /dev/null 2>&1; then
  echo "    Static IP already exists, reusing it."
else
  gcloud compute addresses create "${STATIC_IP_NAME}" \
      --region="${REGION}" \
      --project="${PROJECT}"
fi

STATIC_IP=$(gcloud compute addresses describe "${STATIC_IP_NAME}" \
    --region="${REGION}" \
    --project="${PROJECT}" \
    --format="get(address)")

echo "==> Static IP reserved: ${STATIC_IP}"

# ======================================================
# STEP 4: Write startup script to a temp file
# (avoids shell escaping issues with --metadata inline)
# ======================================================
cat > "${STARTUP_SCRIPT}" << 'STARTUP_EOF'
#!/bin/bash
until docker info > /dev/null 2>&1; do sleep 1; done
APP_DIR=/home/ubuntu/transcoding-app
if [ ! -f "${APP_DIR}/docker-compose.yml" ]; then
  echo "$(date): compose file not found, skipping" >> /var/log/startup.log
  exit 0
fi
cd "${APP_DIR}"
docker compose up -d >> /var/log/startup.log 2>&1
echo "$(date): worker started" >> /var/log/startup.log
STARTUP_EOF

echo "==> Startup script written to ${STARTUP_SCRIPT}"

# ======================================================
# STEP 5: Create the VM
# ======================================================
echo "==> Creating VM (${VM_NAME})..."
gcloud compute instances create "${VM_NAME}" \
    --project="${PROJECT}" \
    --zone="${ZONE}" \
    --machine-type=e2-standard-4 \
    --address="${STATIC_IP_NAME}" \
    --maintenance-policy=TERMINATE \
    --provisioning-model=SPOT \
    --service-account="${SA_EMAIL}" \
    --scopes=https://www.googleapis.com/auth/cloud-platform \
    --create-disk=auto-delete=yes,boot=yes,device-name="${VM_NAME}",image-family=ubuntu-2204-lts,image-project=ubuntu-os-cloud,size=50,type=pd-ssd \
    --metadata="ssh-keys=${PUBLIC_KEY}" \
    --metadata-from-file=startup-script="${STARTUP_SCRIPT}" \
    --labels=env=production,service=transcoding

# ======================================================
# STEP 6: Print everything needed for GitHub Secrets
# ======================================================
echo ""
echo "================================================================"
echo " VM CREATED. Add these 5 secrets to GitHub:"
echo " Repo Settings -> Secrets and variables -> Actions -> New secret"
echo "================================================================"
echo ""
echo "  PROD_TRANSCODING_VM_HOST     = ${STATIC_IP}"
echo "  PROD_TRANSCODING_VM_USERNAME = ubuntu"
echo "  PROD_DB_USER                 = <your production db username>"
echo "  PROD_DB_PASS                 = <your production db password>"
echo ""
echo "  PROD_TRANSCODING_VM_SSH_KEY:"
echo "  (copy the full block below including BEGIN and END lines)"
echo ""
cat "${SSH_KEY_FILE}"
echo ""
echo "================================================================"
echo " Next steps:"
echo "================================================================"
echo "  1. Add the 5 GitHub Secrets above."
echo ""
echo "  2. SSH into the VM and run the one-time setup:"
echo "       gcloud compute ssh ${VM_NAME} --zone=${ZONE}"
echo "       bash setup-transcoding-vm.sh <DB_USER> <DB_PASS>"
echo ""
echo "  3. Scale down the GKE transcoding worker:"
echo "       kubectl scale deployment transcoding-worker -n prod --replicas=0"
echo ""
echo "  4. Trigger the GitHub Action manually:"
echo "       Actions -> Deploy Transcoding Worker to Prod VM -> Run workflow"
