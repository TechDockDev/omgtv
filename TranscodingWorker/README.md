# TranscodingWorker

Video transcoding worker that converts uploaded videos to HLS format with Adaptive Bitrate Streaming (ABR).

## Features

- Listens to Pub/Sub for new upload notifications
- Downloads source video from GCS
- Transcodes to HLS with 4 quality levels (1080p, 720p, 480p, 360p)
- Uploads HLS files to GCS streaming bucket
- Publishes completion event for downstream services

## ABR Quality Levels

| Profile | Resolution | Video Bitrate | Audio |
|---------|------------|---------------|-------|
| 1080p | 1920x1080 | 4500 kbps | 128k |
| 720p | 1280x720 | 2800 kbps | 128k |
| 480p | 854x480 | 1400 kbps | 96k |
| 360p | 640x360 | 800 kbps | 96k |

## Prerequisites

- Node.js 18+
- FFmpeg installed
- GCP credentials configured

## Local Development

```bash
# Install dependencies
npm install

# Copy environment
cp .env.example .env

# Login to GCP
gcloud auth application-default login

# Run
npm run dev
```

## Docker

```bash
docker build -t transcoding-worker .
docker run --env-file .env transcoding-worker
```

## Cloud Run Deployment

```bash
gcloud run deploy transcoding-worker \
  --source . \
  --region asia-south1 \
  --service-account transcoding-worker@PROJECT.iam.gserviceaccount.com
```
