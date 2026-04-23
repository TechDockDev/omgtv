#!/usr/bin/env bash
# One-time setup script for the production transcoding VM.
# Run this once after the VM is created (SSH in and execute it).
# Usage: bash setup-transcoding-vm.sh <DB_USER> <DB_PASS>
set -euo pipefail

DB_USER="${1:?Usage: $0 <DB_USER> <DB_PASS>}"
DB_PASS="${2:?Usage: $0 <DB_USER> <DB_PASS>}"

echo "==> Installing Docker..."
sudo apt-get update -qq
sudo apt-get install -y docker.io docker-compose-v2

# Enable Docker so it starts on every boot (including after Spot preemption)
sudo systemctl enable docker

# Allow ubuntu user to run docker without sudo
sudo usermod -aG docker "$USER"

echo "==> Authenticating Docker with Artifact Registry..."
gcloud auth configure-docker asia-south1-docker.pkg.dev --quiet

echo "==> Creating app directory..."
mkdir -p ~/transcoding-app

echo "==> Writing .env file..."
cat > ~/transcoding-app/.env <<EOF
DB_USER=${DB_USER}
DB_PASS=${DB_PASS}
EOF
chmod 600 ~/transcoding-app/.env

echo ""
echo "==> Setup complete. Log out and back in for docker group to take effect."
echo "    Next: push to master (or trigger deploy-transcoding-vm manually)."
echo "    Then run: cd ~/transcoding-app && docker compose up -d"
