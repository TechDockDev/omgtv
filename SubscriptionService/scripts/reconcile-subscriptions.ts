import { getPrisma, disconnectPrisma } from "../src/lib/prisma";
import { getRazorpay } from "../src/lib/razorpay";

async function reconcile() {
    const prisma = getPrisma();
    const razorpay = getRazorpay();

    try {
        // Find all subscriptions that are still marked as trials
        const stuckSubscriptions = await prisma.userSubscription.findMany({
            where: {
                trialPlanId: { not: null },
                status: "ACTIVE"
            }
        });

        console.log(`Found ${stuckSubscriptions.length} subscriptions with trialPlanId set.`);

        for (const sub of stuckSubscriptions) {
            if (!sub.razorpayOrderId) {
                console.log(`Skipping sub ${sub.id} (no razorpayOrderId)`);
                continue;
            }

            try {
                const rpSub = await razorpay.subscriptions.fetch(sub.razorpayOrderId);

                // Check if Razorpay says trial is over (no trial_end or it's in the past)
                // and status is active
                const isTrialOver = !rpSub.trial_end || (rpSub.trial_end * 1000 < Date.now());

                if (rpSub.status === 'active' && isTrialOver) {
                    console.log(`Updating sub ${sub.id} (userId: ${sub.userId}) - Trial is over in Razorpay.`);

                    await prisma.userSubscription.update({
                        where: { id: sub.id },
                        data: {
                            trialPlanId: null, // Clear trial
                            endsAt: new Date(rpSub.current_end * 1000)
                        }
                    });
                } else {
                    console.log(`Sub ${sub.id} still in trial or non-active status (${rpSub.status})`);
                }
            } catch (err) {
                console.error(`Error fetching/updating sub ${sub.id}:`, err);
            }
        }

        console.log("Reconciliation complete.");
    } catch (err) {
        console.error("Critical error during reconciliation:", err);
    } finally {
        await disconnectPrisma();
        process.exit(0);
    }
}

reconcile();
