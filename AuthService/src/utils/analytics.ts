import { getPostHog } from './posthog';

/**
 * Fire-and-forget analytics for auth events. Never throws into the caller.
 */
export function trackAuthEvent(
  userId: string,
  event: string,
  properties: Record<string, any> = {}
): void {
  try {
    const posthog = getPostHog();
    if (!posthog) return;
    posthog.capture({ distinctId: userId, event, properties });
  } catch (err) {
    console.error(`[AuthAnalytics] Failed to track "${event}":`, err);
  }
}
