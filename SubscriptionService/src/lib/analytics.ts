import { getPostHog } from './posthog';
import { fetchUserDetails } from '../services/userService';
import { getPrisma } from './prisma';

export async function trackSubscriptionEvent(
  userId: string,
  event: string,
  properties: Record<string, any> = {}
): Promise<void> {
  try {
    const posthog = getPostHog();
    if (!posthog) return;
    const prisma = getPrisma();

    const [userMap, plan] = await Promise.all([
      fetchUserDetails([userId]),
      properties.plan_id
        ? prisma.subscriptionPlan.findUnique({
            where: { id: properties.plan_id },
            select: { name: true, pricePaise: true, currency: true, durationDays: true },
          }).catch(() => null)
        : Promise.resolve(null),
    ]);

    const user = userMap.get(userId);
    const props: Record<string, any> = { ...properties };

    if (plan) {
      props.plan_name = plan.name;
      props.plan_price = Math.floor(plan.pricePaise / 100);
      props.plan_currency = plan.currency;
      props.plan_duration_days = plan.durationDays;
    }

    if (user) {
      props.$set = {
        name: user.name,
        email: user.email,
        phone: user.phoneNumber || user.id,
      };
    }

    posthog.capture({ distinctId: userId, event, properties: props });
  } catch (err) {
    console.error(`[Analytics] Failed to track "${event}":`, err);
  }
}
