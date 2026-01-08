import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

export interface ViewerContext {
  userId: string;
  scopes: string[];
  entitlements: string[];
  geo?: string;
  expiresAt: string;
  sessionId?: string;
  tenantId?: string;
  contentRestrictions?: {
    contentId?: string;
    startsAt?: string;
    endsAt?: string;
  };
}

interface AuthServiceClientOptions {
  baseUrl: string;
  introspectionPath: string;
  serviceToken?: string;
  timeoutMs?: number;
  logger: Logger;
}

export class AuthServiceClient {
  private readonly baseUrl: string;
  private readonly introspectionPath: string;
  private readonly timeoutMs: number;
  private readonly serviceToken?: string;
  private readonly logger: Logger;

  constructor(options: AuthServiceClientOptions) {
    this.baseUrl = options.baseUrl;
    this.introspectionPath = options.introspectionPath;
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.serviceToken = options.serviceToken;
    this.logger = options.logger.child({ module: "auth-client" });
  }

  async introspect(
    viewerToken: string,
    correlationId?: string
  ): Promise<ViewerContext> {
    if (!viewerToken) {
      throw new Error("Viewer token is required for manifest requests");
    }

    const url = new URL(this.introspectionPath, this.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-correlation-id": correlationId ?? randomUUID(),
      };
      if (this.serviceToken) {
        headers.authorization = `Bearer ${this.serviceToken}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ token: viewerToken }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        this.logger.warn(
          { statusCode: response.status, body: errorBody },
          "AuthService introspection failed"
        );
        throw new Error(`AuthService introspection failed: ${response.status}`);
      }

      const payload = (await response.json()) as ViewerContext;
      if (!payload || !payload.userId) {
        throw new Error("Viewer context missing from AuthService response");
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }
}
