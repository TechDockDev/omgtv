import crypto from "crypto";
import { loadConfig } from "../config";
import { getPrisma } from "./prisma";

const PHONEPE_BASE: Record<string, string> = {
  UAT: "https://api-preprod.phonepe.com/apis/pg-sandbox",
  PROD: "https://api.phonepe.com/apis/pg",
};

const NON_RETRYABLE_CODES = new Set([
  "TRANSACTION_NOT_PERMITTED",
  "SUBSCRIPTION_INVALID",
  "SUBSCRIPTION_CANCELLED",
  "SUBSCRIPTION_PAUSED",
  "MANDATE_LIMIT_EXCEEDED",
  "FREQUENCY_EXCEEDED",
  "INVALID_TRANSACTION",
  "AUTHORIZATION_FAILURE",
]);

export interface PhonePeSubscriptionStatus {
  subscriptionId?: string; // PhonePe's internal ID — may not be present in all responses
  merchantSubscriptionId: string;
  state: string; // ACTIVATION_IN_PROGRESS | ACTIVE | EXPIRED | FAILED | CANCELLED | PAUSED | ...
  amountType: string;
  maxAmount: number;
  frequency: string;
}

export interface PhonePeRedemptionStatusResult {
  merchantOrderId: string;
  orderId: string;
  state: string; // COMPLETED | FAILED | PENDING
  amount: number;
  errorCode?: string;
  detailedErrorCode?: string;
}

export interface PhonePeOrderTokenResult {
  orderId: string;
  token: string;
  expireAt: number;
}

class PhonePeClient {
  private accessToken: string | null = null;
  private tokenExpiry = 0;

  private get base(): string {
    const config = loadConfig();
    return PHONEPE_BASE[config.PHONEPE_ENV] ?? PHONEPE_BASE.UAT;
  }

  private get isConfigured(): boolean {
    const config = loadConfig();
    return !!(config.PHONEPE_CLIENT_ID && config.PHONEPE_CLIENT_SECRET && config.PHONEPE_MERCHANT_ID);
  }

  private assertConfigured(): void {
    if (!this.isConfigured) {
      throw new Error("PhonePe is not configured. Set PHONEPE_CLIENT_ID, PHONEPE_CLIENT_SECRET, PHONEPE_MERCHANT_ID.");
    }
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry - 60_000) {
      return this.accessToken;
    }
    this.assertConfigured();
    const config = loadConfig();
    const body = new URLSearchParams({
      client_id: config.PHONEPE_CLIENT_ID!,
      client_secret: config.PHONEPE_CLIENT_SECRET!,
      grant_type: "client_credentials",
    });
    const res = await fetch(`${this.base}/v1/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await res.json() as any;
    if (!res.ok || !data.access_token) {
      throw new Error(`PhonePe auth failed: ${JSON.stringify(data)}`);
    }
    this.accessToken = data.access_token as string;
    this.tokenExpiry = Date.now() + (data.expires_in as number) * 1000;
    return this.accessToken;
  }

  private async post<T>(
    path: string,
    body: unknown,
    opts?: { userId?: string; merchantOrderId?: string; merchantSubscriptionId?: string; eventType?: string }
  ): Promise<T> {
    this.assertConfigured();
    const token = await this.getAccessToken();
    const url = `${this.base}${path}`;
    let httpStatus = 0;
    let responseBody: unknown = null;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      httpStatus = res.status;
      responseBody = await res.json();
      await this.log({
        userId: opts?.userId,
        merchantOrderId: opts?.merchantOrderId,
        merchantSubscriptionId: opts?.merchantSubscriptionId,
        eventType: opts?.eventType ?? path,
        direction: "OUTBOUND",
        request: body,
        response: responseBody,
        httpStatus,
        success: res.ok,
      });
      if (!res.ok) {
        const err = responseBody as any;
        const code = err?.code ?? err?.errorCode ?? "UNKNOWN";
        const msg = err?.message ?? err?.userMessage ?? JSON.stringify(err);
        const error = new PhonePeError(msg, code, httpStatus);
        throw error;
      }
      return responseBody as T;
    } catch (err) {
      if (err instanceof PhonePeError) throw err;
      await this.log({
        userId: opts?.userId,
        merchantOrderId: opts?.merchantOrderId,
        merchantSubscriptionId: opts?.merchantSubscriptionId,
        eventType: opts?.eventType ?? path,
        direction: "OUTBOUND",
        request: body,
        response: { error: String(err) },
        httpStatus,
        success: false,
      });
      throw err;
    }
  }

  private async get<T>(
    path: string,
    opts?: { userId?: string; merchantOrderId?: string; merchantSubscriptionId?: string; eventType?: string }
  ): Promise<T> {
    this.assertConfigured();
    const token = await this.getAccessToken();
    const url = `${this.base}${path}`;
    let httpStatus = 0;
    let responseBody: unknown = null;
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      httpStatus = res.status;
      responseBody = await res.json();
      await this.log({
        userId: opts?.userId,
        merchantOrderId: opts?.merchantOrderId,
        merchantSubscriptionId: opts?.merchantSubscriptionId,
        eventType: opts?.eventType ?? path,
        direction: "OUTBOUND",
        request: { path },
        response: responseBody,
        httpStatus,
        success: res.ok,
      });
      if (!res.ok) {
        const err = responseBody as any;
        const code = err?.code ?? err?.errorCode ?? "UNKNOWN";
        const msg = err?.message ?? err?.userMessage ?? JSON.stringify(err);
        throw new PhonePeError(msg, code, httpStatus);
      }
      return responseBody as T;
    } catch (err) {
      if (err instanceof PhonePeError) throw err;
      await this.log({
        userId: opts?.userId,
        merchantOrderId: opts?.merchantOrderId,
        merchantSubscriptionId: opts?.merchantSubscriptionId,
        eventType: opts?.eventType ?? path,
        direction: "OUTBOUND",
        request: { path },
        response: { error: String(err) },
        httpStatus,
        success: false,
      });
      throw err;
    }
  }

  async createSubscriptionOrderToken(params: {
    userId: string;
    merchantSubscriptionId: string;
    merchantOrderId: string;
    amount: number;
    maxAmount: number;
    planId: string;
    isTrial: boolean;
  }): Promise<PhonePeOrderTokenResult> {
    const config = loadConfig();
    const body = {
      merchantId: config.PHONEPE_MERCHANT_ID,
      merchantOrderId: params.merchantOrderId,
      amount: params.amount,
      expireAfter: 1200,
      metaInfo: { udf1: params.userId, udf2: params.planId, udf3: params.isTrial ? "trial" : "subscription" },
      paymentFlow: {
        type: "SUBSCRIPTION_SETUP",
        merchantSubscriptionId: params.merchantSubscriptionId,
        subscriptionDetails: {
          authWorkflowType: "PENNY_DROP",
          amountType: "FIXED",
          maxAmount: params.maxAmount,
          frequency: "ON_DEMAND",
        },
      },
    };
    const res = await this.post<any>("/v2/subscription/order/token", body, {
      userId: params.userId,
      merchantOrderId: params.merchantOrderId,
      merchantSubscriptionId: params.merchantSubscriptionId,
      eventType: "CREATE_ORDER_TOKEN",
    });
    return res.data as PhonePeOrderTokenResult;
  }

  async getSubscriptionStatus(merchantSubscriptionId: string, userId?: string): Promise<PhonePeSubscriptionStatus> {
    const config = loadConfig();
    const res = await this.get<any>(
      `/v2/subscription/${config.PHONEPE_MERCHANT_ID}/${merchantSubscriptionId}/status`,
      { userId, merchantSubscriptionId, eventType: "SUBSCRIPTION_STATUS" }
    );
    return res.data as PhonePeSubscriptionStatus;
  }

  async notifyRedemption(params: {
    userId: string;
    merchantSubscriptionId: string;
    merchantOrderId: string;
    amount: number;
    notifyAt: number;
    expireAt: number;
  }): Promise<void> {
    const config = loadConfig();
    const body = {
      merchantId: config.PHONEPE_MERCHANT_ID,
      merchantOrderId: params.merchantOrderId,
      amount: params.amount,
      expireAt: params.expireAt,
      paymentFlow: {
        type: "SUBSCRIPTION_REDEMPTION",
        merchantSubscriptionId: params.merchantSubscriptionId,
        notifyAt: params.notifyAt,
        autoDebit: false,
      },
    };
    await this.post<any>("/v2/redemption/notify", body, {
      userId: params.userId,
      merchantOrderId: params.merchantOrderId,
      merchantSubscriptionId: params.merchantSubscriptionId,
      eventType: "NOTIFY",
    });
  }

  async executeRedemption(params: {
    userId: string;
    merchantSubscriptionId: string;
    merchantOrderId: string;
    amount: number;
  }): Promise<void> {
    const config = loadConfig();
    const body = {
      merchantId: config.PHONEPE_MERCHANT_ID,
      merchantOrderId: params.merchantOrderId,
      amount: params.amount,
      paymentFlow: {
        type: "SUBSCRIPTION_REDEMPTION",
        merchantSubscriptionId: params.merchantSubscriptionId,
      },
    };
    await this.post<any>("/v2/redemption/execute", body, {
      userId: params.userId,
      merchantOrderId: params.merchantOrderId,
      merchantSubscriptionId: params.merchantSubscriptionId,
      eventType: "EXECUTE",
    });
  }

  async getRedemptionStatus(merchantOrderId: string, userId?: string): Promise<PhonePeRedemptionStatusResult> {
    const config = loadConfig();
    const res = await this.get<any>(
      `/v2/redemption/order/${config.PHONEPE_MERCHANT_ID}/${merchantOrderId}/status`,
      { userId, merchantOrderId, eventType: "REDEMPTION_STATUS" }
    );
    return res.data as PhonePeRedemptionStatusResult;
  }

  async cancelSubscription(merchantSubscriptionId: string, userId?: string): Promise<void> {
    const config = loadConfig();
    const body = { merchantId: config.PHONEPE_MERCHANT_ID, merchantSubscriptionId };
    await this.post<any>(`/v2/subscription/${config.PHONEPE_MERCHANT_ID}/${merchantSubscriptionId}/cancel`, body, {
      userId,
      merchantSubscriptionId,
      eventType: "CANCEL",
    });
  }

  verifyWebhookSignature(authHeader: string): boolean {
    const config = loadConfig();
    if (!config.PHONEPE_CALLBACK_USERNAME || !config.PHONEPE_CALLBACK_PASSWORD) return false;
    // PhonePe SHA auth: sends SHA256(username:password) as the Authorization header
    const expected = crypto
      .createHash("sha256")
      .update(`${config.PHONEPE_CALLBACK_USERNAME}:${config.PHONEPE_CALLBACK_PASSWORD}`)
      .digest("hex");
    return expected === authHeader;
  }

  async logInboundWebhook(params: {
    userId?: string;
    merchantOrderId?: string;
    merchantSubscriptionId?: string;
    eventType: string;
    body: unknown;
    success: boolean;
  }): Promise<void> {
    await this.log({
      userId: params.userId,
      merchantOrderId: params.merchantOrderId,
      merchantSubscriptionId: params.merchantSubscriptionId,
      eventType: params.eventType,
      direction: "INBOUND",
      request: params.body,
      response: null,
      httpStatus: 200,
      success: params.success,
    });
  }

  private async log(entry: {
    userId?: string;
    merchantOrderId?: string;
    merchantSubscriptionId?: string;
    eventType: string;
    direction: string;
    request: unknown;
    response: unknown;
    httpStatus: number;
    success: boolean;
  }): Promise<void> {
    try {
      const prisma = getPrisma();
      await prisma.phonePeEventLog.create({
        data: {
          userId: entry.userId ?? null,
          merchantOrderId: entry.merchantOrderId ?? null,
          merchantSubscriptionId: entry.merchantSubscriptionId ?? null,
          eventType: entry.eventType,
          direction: entry.direction,
          request: entry.request as any,
          response: entry.response as any,
          httpStatus: entry.httpStatus,
          success: entry.success,
        },
      });
    } catch {
      // event log must never throw — it's observability, not critical path
    }
  }
}

export class PhonePeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number
  ) {
    super(message);
    this.name = "PhonePeError";
  }

  get isRetryable(): boolean {
    // httpStatus === 0 means network error (fetch threw before getting a response) — always retry
    return !NON_RETRYABLE_CODES.has(this.code) && (this.httpStatus === 0 || this.httpStatus >= 500);
  }
}

export function isRetryablePhonePeError(err: unknown): boolean {
  if (err instanceof PhonePeError) return err.isRetryable;
  // network errors (fetch throws) are always retryable
  return true;
}

let instance: PhonePeClient | null = null;

export function getPhonePe(): PhonePeClient {
  if (!instance) instance = new PhonePeClient();
  return instance;
}
