import { getServiceDependencies } from "../services/dependencies";
import { ReconciliationService } from "../services/reconciliation-service";

const deps = getServiceDependencies();
const reconciliationService = new ReconciliationService(
  deps.repository,
  deps.channelProvisioner,
  deps.alertingService,
  deps.logger.child({ name: "reconciliation-worker" })
);

export async function reconcileFailedStreams(limit = 20) {
  await reconciliationService.reconcileFailed(limit);
}
