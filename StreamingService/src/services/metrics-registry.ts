import { Counter, Gauge, Histogram, Registry } from "prom-client";

export class MetricsRegistry {
  private readonly registry = new Registry();

  readonly manifestCounter = new Counter({
    name: "streaming_manifest_requests_total",
    help: "Count of manifest requests by result",
    labelNames: ["result"],
    registers: [this.registry],
  });

  readonly viewerGauge = new Gauge({
    name: "streaming_channel_viewers",
    help: "Concurrent viewers per channel",
    labelNames: ["channelId"],
    registers: [this.registry],
  });

  readonly bitrateGauge = new Gauge({
    name: "streaming_channel_bitrate_kbps",
    help: "Average bitrate observed per channel",
    labelNames: ["channelId"],
    registers: [this.registry],
  });

  readonly bufferGauge = new Gauge({
    name: "streaming_channel_buffer_events_per_min",
    help: "Buffer events per minute per channel",
    labelNames: ["channelId"],
    registers: [this.registry],
  });

  readonly trafficDirectorGauge = new Gauge({
    name: "streaming_cdn_multi_cluster_status",
    help: "Traffic Director multi-cluster validation",
    labelNames: ["cluster"],
    registers: [this.registry],
  });

  readonly manifestLatency = new Histogram({
    name: "streaming_manifest_latency_ms",
    help: "Latency for manifest generation",
    labelNames: ["contentId"],
    buckets: [50, 100, 250, 500, 1000, 2000],
    registers: [this.registry],
  });

  readonly probeCounter = new Counter({
    name: "streaming_probe_total",
    help: "Synthetic probe outcomes",
    labelNames: ["region", "result"],
    registers: [this.registry],
  });

  readonly provisioningCounter = new Counter({
    name: "streaming_provisioning_total",
    help: "Provisioning attempts",
    labelNames: ["result"],
    registers: [this.registry],
  });

  recordProvisioning(result: "success" | "failure") {
    this.provisioningCounter.inc({ result });
  }

  recordManifest(result: "success" | "denied" | "error") {
    this.manifestCounter.inc({ result });
  }

  recordManifestLatency(contentId: string, latencyMs: number) {
    this.manifestLatency.observe({ contentId }, latencyMs);
  }

  recordProbe(region: string, result: "success" | "failure") {
    this.probeCounter.inc({ region, result });
  }

  resetRealtimeStats() {
    this.viewerGauge.reset();
    this.bitrateGauge.reset();
    this.bufferGauge.reset();
  }

  recordChannelLoad(channelId: string, viewers: number, bitrateKbps: number) {
    this.viewerGauge.labels(channelId).set(viewers);
    this.bitrateGauge.labels(channelId).set(bitrateKbps);
  }

  recordBufferEvents(channelId: string, eventsPerMinute: number) {
    this.bufferGauge.labels(channelId).set(eventsPerMinute);
  }

  recordTrafficDirector(cluster: string, healthy: boolean) {
    this.trafficDirectorGauge.labels(cluster).set(healthy ? 1 : 0);
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
