import { PostHog } from 'posthog-node';

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY || '';

let instance: PostHog | null = null;

export function getPostHog(): PostHog | null {
  if (!POSTHOG_API_KEY) return null;
  if (!instance) {
    instance = new PostHog(POSTHOG_API_KEY, {
      host: process.env.POSTHOG_HOST || 'https://app.posthog.com',
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return instance;
}

export async function shutdownPostHog(): Promise<void> {
  if (instance) {
    await instance.shutdown();
    instance = null;
  }
}
