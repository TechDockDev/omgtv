import pino, { type Logger } from "pino";
import type { ReadyForStreamEvent } from "../types/upload";
import { ChannelProvisioner } from "./channel-provisioner";
import { NotificationPublisher } from "./notification-publisher";
import type { AlertingService } from "./alerting-service";
import type { ContentServiceClient } from "../clients/content-client";

export interface PubSubMessage {
  data: string;
  attributes?: Record<string, string>;
  messageId: string;
  publishTime: string;
  deliveryAttempt?: number;
}

export interface EventContext {
  eventId: string;
  timestamp: string;
}

interface UploadEventWorkerOptions {
  provisioner: ChannelProvisioner;
  notificationPublisher: NotificationPublisher;
  alertingService: AlertingService;
  contentClient: ContentServiceClient;
  ackDeadlineSeconds: number;
  manifestTtlSeconds: number;
  maxDeliveryAttempts?: number;
  logger?: Logger;
}

export interface WorkerResult {
  action: "ack" | "nack";
  retryInSeconds?: number;
}

export class UploadEventWorker {
  private readonly provisioner: ChannelProvisioner;
  private readonly notificationPublisher: NotificationPublisher;
  private readonly alerting: AlertingService;
  private readonly contentClient: ContentServiceClient;
  private readonly ackDeadlineSeconds: number;
  private readonly manifestTtlSeconds: number;
  private readonly maxDeliveryAttempts: number;
  private readonly logger: Logger;

  constructor(options: UploadEventWorkerOptions) {
    this.provisioner = options.provisioner;
    this.notificationPublisher = options.notificationPublisher;
    this.alerting = options.alertingService;
    this.contentClient = options.contentClient;
    this.ackDeadlineSeconds = options.ackDeadlineSeconds;
    this.manifestTtlSeconds = options.manifestTtlSeconds;
    this.maxDeliveryAttempts = options.maxDeliveryAttempts ?? 5;
    this.logger = options.logger ?? pino({ name: "upload-worker" });
  }

  async handleMessage(
    message: PubSubMessage,
    context?: EventContext
  ): Promise<WorkerResult> {
    const attempt = message.deliveryAttempt ?? 1;
    let event: ReadyForStreamEvent | undefined;
    try {
      event = this.parseEvent(message.data);
      this.logger.info(
        {
          contentId: event.data.videoId,
          messageId: message.messageId,
          attempt,
        },
        "Processing UploadService event"
      );

      await this.contentClient.ensureEpisodeExists(
        event.data.videoId,
        context?.eventId ?? message.messageId
      );

      const metadata = await this.provisioner.provisionFromReadyEvent(event);
      const expiresAt = new Date(
        Date.now() + this.manifestTtlSeconds * 1000
      ).toISOString();
      await this.notificationPublisher.publishPlaybackReady({
        metadata,
        manifestUrl: metadata.playbackUrl,
        expiresAt,
      });
      return { action: "ack" };
    } catch (error) {
      const shouldAck = attempt >= this.maxDeliveryAttempts;
      this.logger.error(
        { err: error, attempt, messageId: message.messageId },
        shouldAck ? "Dropping poison message" : "Upload event failed"
      );
      await this.alerting.ingestFailure(
        event?.data.videoId ?? "unknown",
        error
      );
      if (shouldAck) {
        return { action: "ack" };
      }
      return { action: "nack", retryInSeconds: this.ackDeadlineSeconds };
    }
  }

  private parseEvent(data: string): ReadyForStreamEvent {
    const decoded = Buffer.from(data, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as ReadyForStreamEvent;
    if (parsed.eventType !== "media.ready-for-stream") {
      throw new Error(`Unsupported event type ${parsed.eventType}`);
    }
    return parsed;
  }
}
