# Upload Service API Test Commands

## Prerequisites
- Docker services running
- GCP credentials configured

## 1. Health Check
```bash
curl -X GET http://localhost:5000/health
```

## 2. Issue Signed Upload URL (Admin)
```bash
curl -X POST http://localhost:5000/api/v1/upload/admin/uploads/sign \
  -H "Content-Type: application/json" \
  -H "x-pocketlol-admin-id: test-admin-123" \
  -H "x-pocketlol-admin-roles: SUPER_ADMIN" \
  -H "x-pocketlol-user-type: ADMIN" \
  -H "Authorization: Bearer change-me" \
  -d '{
    "assetType": "video",
    "contentId": "550e8400-e29b-41d4-a716-446655440000",
    "contentClassification": "EPISODE",
    "sizeBytes": 10485760,
    "contentType": "video/mp4",
    "filename": "test-video.mp4"
  }'
```

## 3. Check Upload Status
```bash
curl -X GET "http://localhost:5000/api/v1/upload/admin/uploads/{uploadId}/status" \
  -H "x-pocketlol-admin-id: test-admin-123" \
  -H "x-pocketlol-admin-roles: SUPER_ADMIN" \
  -H "x-pocketlol-user-type: ADMIN" \
  -H "Authorization: Bearer change-me"
```

## 4. Simulate Validation Complete (triggers Pub/Sub)
After upload completes, call validation endpoint:
```bash
curl -X POST "http://localhost:5000/internal/uploads/{uploadId}/validation" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer change-me" \
  -d '{
    "valid": true,
    "checksum": "abc123sha256",
    "durationSeconds": 120,
    "width": 1920,
    "height": 1080,
    "codec": "h264"
  }'
```

## 5. Watch TranscodingWorker Logs
```bash
docker logs omgtv-transcoding-worker-1 -f
```

## Expected Flow
1. Sign URL → Get signedUrl + uploadId
2. Upload video to signedUrl (directly to GCS)
3. Call validation endpoint → Triggers Pub/Sub
4. TranscodingWorker receives message
5. FFmpeg transcodes to HLS
6. HLS uploaded to gs://videos-bucket-pocketlol/hls/{contentId}/
7. Check GCS for output files
