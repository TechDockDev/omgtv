export interface AuditEvent {
  type: string;
  correlationId: string;
  subject?: string;
  principal?: string;
  ip?: string;
  metadata?: Record<string, unknown>;
  occurredAt?: string;
  tenantId?: string;
  source?: string;
}
