import pino from "pino";
import { loadConfig, type Env } from "../config";
import { createChannelMetadataRepository } from "../repositories/channel-metadata-repository";
import { OvenMediaEngineClient } from "../clients/ome-client";
import { NotificationPublisher } from "./notification-publisher";
import { ChannelProvisioner } from "./channel-provisioner";
import { CdnControlClient } from "../clients/cdn-client";
import { CdnTokenSigner } from "../utils/cdn-signature";
import { AuthServiceClient } from "../clients/auth-client";
import { ContentServiceClient } from "../clients/content-client";
import { AlertingService } from "./alerting-service";
import { MetricsRegistry } from "./metrics-registry";
import type { ChannelMetadataRepository } from "../repositories/channel-metadata-repository";
import { AnalyticsExporter } from "../observability/analytics-exporter";
import { MonitoringService } from "./monitoring-service";

export interface ServiceDependencies {
  config: Env;
  logger: pino.Logger;
  repository: ChannelMetadataRepository;
  omeClient: OvenMediaEngineClient;
  notificationPublisher: NotificationPublisher;
  channelProvisioner: ChannelProvisioner;
  cdnClient: CdnControlClient;
  cdnSigner: CdnTokenSigner;
  authClient: AuthServiceClient;
  contentClient: ContentServiceClient;
  alertingService: AlertingService;
  metrics: MetricsRegistry;
  analytics: AnalyticsExporter;
  monitoring: MonitoringService;
}

let cached: ServiceDependencies | null = null;

export function getServiceDependencies(): ServiceDependencies {
  if (cached) {
    return cached;
  }

  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL, name: "streaming-service" });

  const repository = createChannelMetadataRepository(config, logger);
  const omeClient = new OvenMediaEngineClient({
    baseUrl: config.OME_API_BASE_URL,
    apiKey: config.OME_API_KEY,
    apiSecret: config.OME_API_SECRET,
    dryRun: config.DRY_RUN_PROVISIONING,
    logger,
  });

  const analytics = new AnalyticsExporter({
    endpointUrl: config.BIGQUERY_EXPORT_URL,
    logger,
  });

  const notificationPublisher = new NotificationPublisher({
    contentServiceUrl: config.CONTENT_SERVICE_CALLBACK_URL,
    cacheWarmupUrl: config.API_GATEWAY_CACHE_WARMUP_URL,
    observabilityUrl: config.OBSERVABILITY_EXPORT_URL,
    analyticsExporter: analytics,
    logger,
  });

  const channelProvisioner = new ChannelProvisioner({
    omeClient,
    repository,
    manifestBucket: config.GCS_MANIFEST_BUCKET,
    reelsPreset: config.OME_REELS_PRESET,
    seriesPreset: config.OME_SERIES_PRESET,
    reelsApplication: config.OME_REELS_APPLICATION,
    seriesApplication: config.OME_SERIES_APPLICATION,
    reelsIngestPool: config.OME_REELS_INGEST_POOL,
    seriesIngestPool: config.OME_SERIES_INGEST_POOL,
    reelsEgressPool: config.OME_REELS_EGRESS_POOL,
    seriesEgressPool: config.OME_SERIES_EGRESS_POOL,
    maxProvisionRetries: config.MAX_PROVISION_RETRIES,
    cdnBaseUrl: config.CDN_BASE_URL,
    signingKeyId: config.CDN_SIGNING_KEY_ID,
    dryRun: config.DRY_RUN_PROVISIONING,
    logger,
  });

  const cdnClient = new CdnControlClient({
    baseUrl: config.CDN_CONTROL_BASE_URL,
    apiKey: config.CDN_CONTROL_API_KEY,
    logger,
    analytics,
  });

  const cdnSigner = new CdnTokenSigner({
    signingKeyId: config.CDN_SIGNING_KEY_ID,
    signingSecret: config.CDN_SIGNING_SECRET,
    primaryBaseUrl: config.CDN_BASE_URL,
    failoverBaseUrl: config.CDN_FAILOVER_BASE_URL,
  });

  const authClient = new AuthServiceClient({
    baseUrl: config.AUTH_SERVICE_BASE_URL,
    introspectionPath: config.AUTH_SERVICE_INTROSPECTION_PATH,
    serviceToken: config.AUTH_SERVICE_INTERNAL_TOKEN,
    timeoutMs: config.AUTH_SERVICE_TIMEOUT_MS,
    logger,
  });

  const contentClient = new ContentServiceClient({
    baseUrl: config.CONTENT_SERVICE_BASE_URL,
    serviceToken: config.CONTENT_SERVICE_INTERNAL_TOKEN,
    timeoutMs: config.CONTENT_SERVICE_TIMEOUT_MS,
    logger,
  });

  const alertingService = new AlertingService({
    observabilityUrl: config.OBSERVABILITY_EXPORT_URL,
    auditTopic: config.AUDIT_LOG_TOPIC,
    analyticsExporter: analytics,
    logger,
  });

  const metrics = new MetricsRegistry();
  const monitoring = new MonitoringService(
    omeClient,
    metrics,
    cdnClient,
    analytics,
    logger
  );

  cached = {
    config,
    logger,
    repository,
    omeClient,
    notificationPublisher,
    channelProvisioner,
    cdnClient,
    cdnSigner,
    authClient,
    contentClient,
    alertingService,
    metrics,
    analytics,
    monitoring,
  };

  return cached;
}
