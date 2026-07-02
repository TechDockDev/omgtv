import { loadConfig } from "../config";
import type { FunnelDef } from "./funnel-definitions";

export interface FunnelStepResult {
  step: number;
  name: string;
  event: string;
  count: number;
  stepConvPct: number | null;
  overallPct: number;
  dropOff: number;
}

export async function queryPostHogFunnel(params: {
  funnel: FunnelDef;
  dateFrom: string;
  dateTo: string;
  platform?: "all" | "android" | "ios";
}): Promise<FunnelStepResult[]> {
  const config = loadConfig();
  const { POSTHOG_PERSONAL_API_KEY: apiKey, POSTHOG_PROJECT_ID: projectId, POSTHOG_HOST: host } = config;

  if (!apiKey || !projectId) throw new Error("PostHog not configured: missing POSTHOG_PERSONAL_API_KEY or POSTHOG_PROJECT_ID");

  const { funnel, dateFrom, dateTo, platform } = params;

  // Platform filter applied to every step via event properties
  const platformProps = (platform && platform !== "all")
    ? [{ key: "$os", value: platform === "android" ? "Android" : "iOS", operator: "exact", type: "event" }]
    : [];

  const query = {
    kind: "FunnelsQuery",
    series: funnel.steps.map((step) => ({
      kind: "EventsNode",
      event: step.event,
      properties: [...platformProps, ...(step.properties ?? [])],
    })),
    dateRange: { date_from: dateFrom, date_to: dateTo },
    funnelWindowInterval: funnel.conversionWindowInterval,
    funnelWindowIntervalUnit: funnel.conversionWindowUnit,
    filterTestAccounts: true,
  };

  const res = await fetch(`${host}/api/projects/${projectId}/query/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PostHog query failed ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json() as any;

  // PostHog returns `results` (array of step objects) for FunnelsQuery
  const rawSteps: any[] = Array.isArray(data.results)
    ? data.results
    : Array.isArray(data.result)
      ? data.result
      : [];

  // Zero-fill if PostHog returned nothing
  if (rawSteps.length === 0) {
    return funnel.steps.map((step, i) => ({
      step: i + 1,
      name: step.label,
      event: step.event,
      count: 0,
      stepConvPct: i === 0 ? null : 0,
      overallPct: i === 0 ? 100 : 0,
      dropOff: 0,
    }));
  }

  const sorted = [...rawSteps].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const firstCount: number = sorted[0]?.count ?? 0;

  return sorted.map((raw, i) => {
    const count: number = raw.count ?? 0;
    const prevCount: number = i === 0 ? 0 : (sorted[i - 1]?.count ?? 0);
    return {
      step: i + 1,
      name: funnel.steps[i]?.label ?? raw.name ?? `Step ${i + 1}`,
      event: funnel.steps[i]?.event ?? raw.action_id ?? "",
      count,
      stepConvPct: i === 0 ? null : prevCount > 0 ? +((count / prevCount) * 100).toFixed(1) : 0,
      overallPct: firstCount > 0 ? +((count / firstCount) * 100).toFixed(1) : (i === 0 ? 100 : 0),
      dropOff: i === 0 ? 0 : prevCount - count,
    };
  });
}
