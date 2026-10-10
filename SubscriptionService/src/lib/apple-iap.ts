import {
  AppStoreServerAPIClient,
  SignedDataVerifier,
  Environment,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload,
} from "@apple/app-store-server-library";
import { loadConfig } from "../config";
import { getAppleRootCertificates } from "./apple-root-ca";

export class AppleIapNotConfiguredError extends Error {
  constructor() {
    super(
      "Apple IAP is not configured (APPLE_IAP_KEY_ID / APPLE_IAP_ISSUER_ID / APPLE_IAP_PRIVATE_KEY / APPLE_IAP_BUNDLE_ID)"
    );
    this.name = "AppleIapNotConfiguredError";
  }
}

export interface AppleIapClient {
  /**
   * Fetches the transaction fresh from Apple's own servers (not trusting the
   * client's copy) and verifies its signature/certificate chain. This is the
   * "verify using the App Store Server API" step — never the deprecated
   * verifyReceipt endpoint.
   */
  verifyTransactionId(transactionId: string): Promise<JWSTransactionDecodedPayload>;
  /** Verifies and decodes an App Store Server Notifications V2 signedPayload. */
  verifyNotificationPayload(signedPayload: string): Promise<ResponseBodyV2DecodedPayload>;
  /**
   * Verifies and decodes an already-known signedTransactionInfo JWS (e.g. the
   * one nested inside a notification's `data`) without a fresh API call —
   * it's already Apple-signed data, just needs its own decode.
   */
  decodeSignedTransaction(signedTransactionInfo: string): Promise<JWSTransactionDecodedPayload>;
}

function buildClient(): AppleIapClient | null {
  const config = loadConfig();
  const {
    APPLE_IAP_KEY_ID,
    APPLE_IAP_ISSUER_ID,
    APPLE_IAP_PRIVATE_KEY,
    APPLE_IAP_BUNDLE_ID,
    APPLE_IAP_ENVIRONMENT,
    APPLE_IAP_APP_APPLE_ID,
  } = config;

  if (!APPLE_IAP_KEY_ID || !APPLE_IAP_ISSUER_ID || !APPLE_IAP_PRIVATE_KEY || !APPLE_IAP_BUNDLE_ID) {
    return null;
  }

  const environment = APPLE_IAP_ENVIRONMENT === "PRODUCTION" ? Environment.PRODUCTION : Environment.SANDBOX;

  const apiClient = new AppStoreServerAPIClient(
    APPLE_IAP_PRIVATE_KEY,
    APPLE_IAP_KEY_ID,
    APPLE_IAP_ISSUER_ID,
    APPLE_IAP_BUNDLE_ID,
    environment
  );

  const verifier = new SignedDataVerifier(
    getAppleRootCertificates(),
    true, // enableOnlineChecks — revocation + expiry checked against real time
    environment,
    APPLE_IAP_BUNDLE_ID,
    APPLE_IAP_APP_APPLE_ID
  );

  return {
    async verifyTransactionId(transactionId: string) {
      const { signedTransactionInfo } = await apiClient.getTransactionInfo(transactionId);
      if (!signedTransactionInfo) {
        throw new Error("Apple's getTransactionInfo returned no signedTransactionInfo");
      }
      return verifier.verifyAndDecodeTransaction(signedTransactionInfo);
    },
    async verifyNotificationPayload(signedPayload: string) {
      return verifier.verifyAndDecodeNotification(signedPayload);
    },
    async decodeSignedTransaction(signedTransactionInfo: string) {
      return verifier.verifyAndDecodeTransaction(signedTransactionInfo);
    },
  };
}

// undefined = not yet built, null = built and confirmed unconfigured.
let instance: AppleIapClient | null | undefined;

export function getAppleIap(): AppleIapClient {
  if (instance === undefined) instance = buildClient();
  if (!instance) throw new AppleIapNotConfiguredError();
  return instance;
}

export function isAppleIapConfigured(): boolean {
  if (instance === undefined) instance = buildClient();
  return instance !== null;
}
