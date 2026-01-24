import type { Redis } from "ioredis";

export type CatalogEvent = {
  type: "catalog.updated";
  entity: "category" | "series" | "season" | "episode" | "mediaAsset" | "tag";
  entityId: string;
  operation: "create" | "update" | "delete";
  timestamp: string;
  payload?: Record<string, unknown>;
};

export interface CatalogEventsPublisher {
  publish(event: CatalogEvent): Promise<void>;
}

export class RedisCatalogEventsPublisher implements CatalogEventsPublisher {
  constructor(
    private readonly redis: Redis,
    private readonly streamKey: string
  ) { }

  async publish(event: CatalogEvent): Promise<void> {
    await this.redis.xadd(
      this.streamKey,
      "*",
      "type",
      event.type,
      "entity",
      event.entity,
      "entityId",
      event.entityId,
      "operation",
      event.operation,
      "timestamp",
      event.timestamp,
      "payload",
      JSON.stringify(event.payload ?? {})
    );
  }
}
