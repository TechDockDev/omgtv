import { exportJWK, importSPKI } from "jose";

let cachedJwks: { keys: Array<Record<string, unknown>> } | null = null;

export async function buildJwks(params: {
  publicKey: string;
  keyId: string;
}) {
  if (cachedJwks) {
    return cachedJwks;
  }
  const { publicKey, keyId } = params;
  const key = await importSPKI(publicKey, "RS256");
  const jwk = await exportJWK(key);
  cachedJwks = {
    keys: [
      {
        ...jwk,
        kty: "RSA",
        use: "sig",
        kid: keyId,
        alg: "RS256",
      },
    ],
  };
  return cachedJwks;
}
