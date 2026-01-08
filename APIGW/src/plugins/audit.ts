import fp from "fastify-plugin";
import { request } from "undici";
import { loadConfig } from "../config";
import type { AuditEvent } from "../types/audit";

const DEFAULT_TIMEOUT = 2_000;

export default fp(
  async function auditPlugin(fastify) {
    const config = loadConfig();
    const telemetryEnabled = Boolean(config.ENABLE_AUDIT_EVENTS);
    const sinkUrl = config.AUDIT_EVENT_SINK_URL;
    const sinkToken = config.AUDIT_EVENT_SINK_TOKEN;
    const timeout = config.AUDIT_EVENT_SINK_TIMEOUT_MS ?? DEFAULT_TIMEOUT;

    async function sendToSink(event: AuditEvent & { occurredAt: string }) {
      if (!telemetryEnabled) {
        fastify.log.debug(
          { eventType: event.type },
          "Audit event suppressed because auditing is disabled"
        );
        return;
      }

      if (!sinkUrl) {
        fastify.log.info(
          { event },
          "Audit event recorded without sink configuration"
        );
        return;
      }

      try {
        await request(sinkUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(sinkToken ? { authorization: `Bearer ${sinkToken}` } : {}),
          },
          body: JSON.stringify(event),
          bodyTimeout: timeout,
          headersTimeout: timeout,
        });
      } catch (error) {
        fastify.log.error(
          { err: error, eventType: event.type },
          "Failed to publish audit event"
        );
      }
    }

    fastify.decorate(
      "publishAuditEvent",
      async (event: AuditEvent): Promise<void> => {
        const occurredAt = event.occurredAt ?? new Date().toISOString();
        const payload = {
          ...event,
          occurredAt,
          source: event.source ?? config.SERVICE_NAME,
        };
        await sendToSink(payload);
      }
    );
  },
  { name: "audit" }
);
