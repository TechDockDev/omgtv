import { getServiceDependencies } from "../services/dependencies";
import {
  EventContext,
  PubSubMessage,
  UploadEventWorker,
} from "../services/upload-event-worker";

const deps = getServiceDependencies();
const worker = new UploadEventWorker({
  provisioner: deps.channelProvisioner,
  notificationPublisher: deps.notificationPublisher,
  alertingService: deps.alertingService,
  contentClient: deps.contentClient,
  ackDeadlineSeconds: deps.config.UPLOAD_EVENT_ACK_DEADLINE_SECONDS,
  manifestTtlSeconds: deps.config.SIGNED_URL_TTL_SECONDS,
  maxDeliveryAttempts: deps.config.MAX_PROVISION_RETRIES,
  logger: deps.logger.child({ name: "upload-event-worker" }),
});

export async function handleUploadEvent(
  message: PubSubMessage,
  context: EventContext
) {
  return worker.handleMessage(message, context);
}
