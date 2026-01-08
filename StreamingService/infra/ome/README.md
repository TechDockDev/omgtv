# OvenMediaEngine Deployment Assets

This directory contains baseline Kubernetes manifests used to run OvenMediaEngine (OME) on GKE Autopilot.

| File | Purpose |
| --- | --- |
| `configmap.yaml` | Channel templates, ABR presets, CDN cache policies |
| `secret.yaml` | Ingest keys, DRM packs, Cloud CDN signed key material |
| `deployment.yaml` | StatefulSet + Services for OME headend nodes |

Apply manifests with `kubectl apply -k infra/ome` after rendering secrets via Secret Manager.
