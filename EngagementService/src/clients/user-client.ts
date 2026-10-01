import { loadConfig } from "../config";

// Resolves a customer's registered phone from UserService. Returns null on any
// failure so callers can degrade instead of failing the request.
export async function fetchCustomerPhone(userId: string): Promise<string | null> {
  const config = loadConfig();
  try {
    const res = await fetch(`${config.USER_SERVICE_URL}/internal/users/batch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.SERVICE_AUTH_TOKEN ? { "x-service-token": config.SERVICE_AUTH_TOKEN } : {}),
      },
      body: JSON.stringify({ userIds: [userId] }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { users?: Record<string, { phone: string | null }> };
    return data.users?.[userId]?.phone ?? null;
  } catch {
    return null;
  }
}

/** "+91 98765 43210" / "+919876543210" / "09876543210" -> "9876543210" */
export function normalizeIndianMobile(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  const last10 = digits.slice(-10);
  return /^[6-9]\d{9}$/.test(last10) ? last10 : null;
}
