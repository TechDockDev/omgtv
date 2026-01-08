import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  SERVER_HOST: z.string().default("0.0.0.0"),
  SERVER_PORT: z.coerce.number().int().positive().default(3000),
  SERVER_BODY_LIMIT: z.coerce.number().int().positive().default(1_048_576),
  SERVER_TRUST_PROXY: z
    .string()
    .default("true")
    .transform((value) => value !== "false"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  REDIS_URL: z.string().url(),
  RATE_LIMIT_ANON: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_AUTH: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_ADMIN: z.coerce.number().int().positive().default(500),
  AUTH_JWKS_URL: z.string().url(),
  AUTH_AUDIENCE: z.string(),
  AUTH_ISSUER: z.string(),
  AUTH_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  CONTENT_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(120),
  ENABLE_REQUEST_LOGGING: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  CDN_ALLOWED_HOSTS: z.string().optional(),
  STREAMING_SERVICE_URL: z.string().url(),
  CONTENT_SERVICE_URL: z.string().url(),
  AUTH_SERVICE_URL: z.string().url(),
  USER_SERVICE_URL: z.string().url(),
  UPLOAD_SERVICE_URL: z.string().url(),
  ENGAGEMENT_SERVICE_URL: z.string().url(),
  SEARCH_SERVICE_URL: z.string().url(),
  SUBSCRIPTION_SERVICE_URL: z.string().url(),
  SERVICE_AUTH_TOKEN: z.string().optional(),
  ENABLE_TELEMETRY: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  SERVICE_NAME: z.string().default("pocketlol-gateway"),
  ENABLE_AUDIT_EVENTS: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  AUDIT_EVENT_SINK_URL: z.string().url().optional(),
  AUDIT_EVENT_SINK_TOKEN: z.string().optional(),
  AUDIT_EVENT_SINK_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  ROUTES_ENABLED: z.string().optional(),
  ROUTES_DISABLED: z.string().optional(),
  SERVICE_ENDPOINT_OVERRIDES: z.string().optional(),
});

export type AppConfig = ReturnType<typeof loadConfig>;

let cachedConfig:
  | {
      readonly env: z.infer<typeof envSchema>;
    }
  | undefined;
let cachedRouteToggles:
  | {
      enabled?: ReadonlySet<RouteKey>;
      disabled?: ReadonlySet<RouteKey>;
    }
  | undefined;
let cachedServiceOverrides: Readonly<Record<ServiceKey, string>> | undefined;

const ROUTE_KEYS = [
  "auth",
  "content",
  "videos",
  "upload",
  "engagement",
  "search",
  "subscription",
] as const;

const SERVICE_KEYS = [
  "auth",
  "user",
  "content",
  "streaming",
  "upload",
  "engagement",
  "search",
  "subscription",
] as const;

export type RouteKey = (typeof ROUTE_KEYS)[number];
export type ServiceKey = (typeof SERVICE_KEYS)[number];

export function loadConfig() {
  if (cachedConfig) {
    return cachedConfig.env;
  }

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`
    );
    throw new Error(`Invalid environment configuration: ${issues.join("; ")}`);
  }

  cachedConfig = {
    env: parsed.data,
  } as const;

  return cachedConfig.env;
}

function parseCsv(value?: string) {
  if (!value) {
    return [] as const;
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function toRouteKey(value: string): RouteKey | undefined {
  const normalized = value.toLowerCase();
  return ROUTE_KEYS.find((route) => route === normalized) as
    | RouteKey
    | undefined;
}

function ensureRouteToggles() {
  if (cachedRouteToggles) {
    return cachedRouteToggles;
  }

  const config = loadConfig();
  const enabledList = parseCsv(config.ROUTES_ENABLED)
    .map(toRouteKey)
    .filter((route): route is RouteKey => Boolean(route));
  const disabledList = parseCsv(config.ROUTES_DISABLED)
    .map(toRouteKey)
    .filter((route): route is RouteKey => Boolean(route));

  cachedRouteToggles = {
    enabled: enabledList.length ? new Set(enabledList) : undefined,
    disabled: disabledList.length ? new Set(disabledList) : undefined,
  } as const;

  return cachedRouteToggles;
}

const SERVICE_ENV_MAP: Record<ServiceKey, keyof z.infer<typeof envSchema>> = {
  auth: "AUTH_SERVICE_URL",
  user: "USER_SERVICE_URL",
  content: "CONTENT_SERVICE_URL",
  streaming: "STREAMING_SERVICE_URL",
  upload: "UPLOAD_SERVICE_URL",
  engagement: "ENGAGEMENT_SERVICE_URL",
  search: "SEARCH_SERVICE_URL",
  subscription: "SUBSCRIPTION_SERVICE_URL",
} as const;

function parseServiceOverrides(): Readonly<Record<ServiceKey, string>> {
  if (cachedServiceOverrides) {
    return cachedServiceOverrides;
  }

  const config = loadConfig();
  const overrides: Partial<Record<ServiceKey, string>> = {};
  const entries = parseCsv(config.SERVICE_ENDPOINT_OVERRIDES);

  for (const entry of entries) {
    const [rawKey, rawUrl] = entry.split("=").map((part) => part.trim());
    if (!rawKey || !rawUrl) {
      continue;
    }
    const key = rawKey.toLowerCase() as ServiceKey;
    if (!SERVICE_KEYS.includes(key)) {
      continue;
    }
    try {
      // Validate URL format early to surface misconfiguration.
      // eslint-disable-next-line no-new
      new URL(rawUrl);
      overrides[key] = rawUrl;
    } catch {
      throw new Error(
        `Invalid URL provided for service override '${rawKey}': ${rawUrl}`
      );
    }
  }

  cachedServiceOverrides = overrides as Readonly<Record<ServiceKey, string>>;
  return cachedServiceOverrides;
}

export function getServiceUrl(
  service: keyof Pick<
    z.infer<typeof envSchema>,
    | "AUTH_SERVICE_URL"
    | "USER_SERVICE_URL"
    | "CONTENT_SERVICE_URL"
    | "STREAMING_SERVICE_URL"
    | "UPLOAD_SERVICE_URL"
    | "ENGAGEMENT_SERVICE_URL"
    | "SEARCH_SERVICE_URL"
    | "SUBSCRIPTION_SERVICE_URL"
  >
) {
  const mappingEntry = Object.entries(SERVICE_ENV_MAP).find(
    ([, envName]) => envName === service
  ) as [ServiceKey, typeof service] | undefined;
  if (mappingEntry) {
    return resolveServiceUrl(mappingEntry[0]);
  }
  const config = loadConfig();
  return config[service];
}

export function getRateLimitConfig() {
  const config = loadConfig();
  return {
    anonymous: config.RATE_LIMIT_ANON,
    authenticated: config.RATE_LIMIT_AUTH,
    admin: config.RATE_LIMIT_ADMIN,
  } as const;
}

export function isProduction() {
  const config = loadConfig();
  return config.NODE_ENV === "production";
}

export function getContentCacheTtlSeconds() {
  const config = loadConfig();
  return config.CONTENT_CACHE_TTL_SECONDS;
}

export function getCorsOrigins(): string[] {
  const config = loadConfig();
  if (!config.CORS_ALLOWED_ORIGINS) {
    return [];
  }
  return config.CORS_ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function getCdnHosts(): string[] {
  const config = loadConfig();
  if (!config.CDN_ALLOWED_HOSTS) {
    return [];
  }
  return config.CDN_ALLOWED_HOSTS.split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}

export function resetConfigCache() {
  cachedConfig = undefined;
  cachedRouteToggles = undefined;
  cachedServiceOverrides = undefined;
}

export function isRouteEnabled(route: RouteKey): boolean {
  const toggles = ensureRouteToggles();
  if (toggles.enabled && toggles.enabled.size > 0) {
    return toggles.enabled.has(route);
  }
  if (toggles.disabled && toggles.disabled.size > 0) {
    return !toggles.disabled.has(route);
  }
  return true;
}

export function getEnabledRoutes(): RouteKey[] {
  const toggles = ensureRouteToggles();
  const disabled = toggles.disabled ?? new Set<RouteKey>();
  if (toggles.enabled && toggles.enabled.size > 0) {
    return [...toggles.enabled];
  }
  return ROUTE_KEYS.filter((route) => !disabled.has(route));
}

export function getServiceEndpointOverrides(): Readonly<
  Record<ServiceKey, string>
> {
  return parseServiceOverrides();
}

export function resolveServiceUrl(service: ServiceKey): string {
  const overrides = parseServiceOverrides();
  if (overrides[service]) {
    return overrides[service];
  }
  const config = loadConfig();
  return config[SERVICE_ENV_MAP[service]] as string;
}

export { ROUTE_KEYS };
