import { resolveServiceUrl } from "./index";
import type { ServiceDefinition } from "../types/service";

const AUTH_BASE_PATH = "/api/v1/auth" as const;
const USER_BASE_PATH = "/api/v1/user" as const;
const CONTENT_BASE_PATH = "/api/v1/content" as const;
const ENGAGEMENT_BASE_PATH = "/api/v1/engagement" as const;
const SEARCH_BASE_PATH = "/api/v1/search" as const;
const SUBSCRIPTION_BASE_PATH = "/api/v1/subscription" as const;

export function getServiceRegistry(): readonly ServiceDefinition[] {
  return [
    {
      name: "auth",
      displayName: "Auth Service",
      description: "Authentication and token issuance",
      basePath: AUTH_BASE_PATH,
      target: resolveServiceUrl("auth"),
      swaggerPath: "/v3/api-docs",
      access: "public",
      rateLimitPolicy: "anonymous",
      internalBasePath: "",
      publicPrefixes: ["/public"],
      documentationBasePath: "",
      exposeViaProxy: false,
    },
    {
      name: "user",
      displayName: "User Service",
      description: "Role-based access control management",
      basePath: USER_BASE_PATH,
      target: resolveServiceUrl("user"),
      swaggerPath: "/v3/api-docs",
      access: "admin",
      rateLimitPolicy: "admin",
      internalBasePath: "/",
    },
    {
      name: "content",
      displayName: "Content Service",
      description: "Catalog discovery and playback metadata",
      basePath: CONTENT_BASE_PATH,
      target: resolveServiceUrl("content"),
      swaggerPath: "/openapi.json",
      access: "admin",
      rateLimitPolicy: "admin",
      internalBasePath: "/api/v1/content",
      publicPrefixes: ["/catalog", "/mobile"],
      adminPrefixes: ["/admin"],
    },
    {
      name: "engagement",
      displayName: "Engagement Service",
      description: "Likes, saves, views, and engagement stats",
      basePath: ENGAGEMENT_BASE_PATH,
      target: resolveServiceUrl("engagement"),
      swaggerPath: "/openapi.json",
      access: "authenticated",
      rateLimitPolicy: "authenticated",
      internalBasePath: ENGAGEMENT_BASE_PATH,
    },
    {
      name: "search",
      displayName: "Search Service",
      description: "Public search across the catalog",
      basePath: SEARCH_BASE_PATH,
      target: resolveServiceUrl("search"),
      swaggerPath: "/openapi.json",
      access: "public",
      rateLimitPolicy: "anonymous",
      internalBasePath: SEARCH_BASE_PATH,
    },
    {
      name: "subscription",
      displayName: "Subscription Service",
      description: "Plans, purchases, entitlements",
      basePath: SUBSCRIPTION_BASE_PATH,
      target: resolveServiceUrl("subscription"),
      swaggerPath: "/openapi.json",
      access: "authenticated",
      rateLimitPolicy: "authenticated",
      internalBasePath: SUBSCRIPTION_BASE_PATH,
      adminPrefixes: ["/admin"],
    },
    {
      name: "streaming",
      displayName: "Streaming Service",
      description: "Playback manifests and stream control plane",
      basePath: "/api/v1/streams",
      target: resolveServiceUrl("streaming"),
      swaggerPath: "/openapi.json",
      access: "authenticated",
      rateLimitPolicy: "authenticated",
      internalBasePath: "/v1/streams",
      adminPrefixes: ["/admin"],
    },
    {
      name: "upload",
      displayName: "Upload Service",
      description: "Administrative asset upload orchestration",
      basePath: "/api/v1/admin/uploads",
      target: resolveServiceUrl("upload"),
      swaggerPath: "/openapi.json",
      access: "admin",
      rateLimitPolicy: "admin",
      internalBasePath: "/v1/admin/uploads",
      exposeViaProxy: false,
      documentationBasePath: "/api/v1/admin/uploads",
    },
  ] as const;
}
