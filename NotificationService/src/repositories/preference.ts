import prisma from '../prisma';
import { UserNotificationPreference } from '@prisma/client';

export const PreferenceRepository = {
    get: async (userId: string) => {
        const pref = await prisma.userNotificationPreference.findUnique({ where: { userId } });
        if (!pref) {
            // Return default preferences if none exist
            return prisma.userNotificationPreference.create({
                data: { userId }
            });
        }
        return pref;
    },

    update: async (userId: string, data: Partial<Omit<UserNotificationPreference, 'userId' | 'createdAt' | 'updatedAt'>>) => {
        return prisma.userNotificationPreference.upsert({
            where: { userId },
            create: { userId, ...data },
            update: data,
        });
    }
};
