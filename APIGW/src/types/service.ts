export type ServiceAccess = "public" | "authenticated" | "admin";

export interface ServiceDefinition {
  readonly name: string;
  readonly displayName: string;
  readonly description?: string;
  readonly basePath: `/${string}`;
  readonly target: string;
  readonly swaggerPath: string;
  readonly access?: ServiceAccess;
  readonly rateLimitPolicy?: "anonymous" | "authenticated" | "admin";
  readonly internalBasePath?: `/${string}` | "";
  readonly publicPrefixes?: readonly string[];
  readonly adminPrefixes?: readonly string[];
  readonly documentationBasePath?: `/${string}` | "";
  readonly exposeViaProxy?: boolean;
}

export interface ServiceSwaggerDocument {
  readonly service: ServiceDefinition;
  readonly document: Record<string, unknown>;
}
