import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import {
  applicationDefault,
  cert,
  getApp,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { loadConfig } from "../config";

export interface FirebaseAuthIntegration {
  verifyIdToken(idToken: string): Promise<DecodedIdToken>;
}

const APP_NAME = "pocketlol-auth";

function decodeServiceAccount(b64?: string) {
  if (!b64) {
    return undefined;
  }
  const buffer = Buffer.from(b64, "base64");
  try {
    return JSON.parse(buffer.toString("utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error("Invalid FIREBASE_CREDENTIALS_B64 payload");
  }
}

export default fp(async function firebasePlugin(fastify: FastifyInstance) {
  const config = loadConfig();

  const existingApps = getApps();
  const firebaseApp = existingApps.find((app) => app.name === APP_NAME)
    ? getApp(APP_NAME)
    : initializeApp(
        {
          credential: (() => {
            const serviceAccount = decodeServiceAccount(
              config.FIREBASE_CREDENTIALS_B64
            );
            if (serviceAccount) {
              return cert(serviceAccount);
            }
            return applicationDefault();
          })(),
          projectId: config.FIREBASE_PROJECT_ID,
        },
        APP_NAME
      );

  const authClient = getAuth(firebaseApp);

  const integration: FirebaseAuthIntegration = {
    async verifyIdToken(idToken: string) {
      return authClient.verifyIdToken(idToken, true);
    },
  };

  fastify.decorate("firebaseAuth", integration);
});

declare module "fastify" {
  interface FastifyInstance {
    firebaseAuth: FirebaseAuthIntegration;
  }
}
