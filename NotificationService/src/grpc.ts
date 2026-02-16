import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { NotificationManager } from './services/notification-manager';
import { NotificationType } from '@prisma/client';

const PROTO_PATH = path.join(__dirname, '../proto/notification.proto');

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
});

const notificationProto = grpc.loadPackageDefinition(packageDefinition).notification as any;

let notificationManager: NotificationManager | null = null;
function getNotificationManager(): NotificationManager {
    if (!notificationManager) {
        notificationManager = new NotificationManager();
    }
    return notificationManager;
}

const sendNotification = async (call: any, callback: any) => {
    const { userId, type, title, body, payloadJson, priority } = call.request;

    try {
        const payload = payloadJson ? JSON.parse(payloadJson) : {};
        // Map string type to enum
        const notifType = type as NotificationType;

        const result = await getNotificationManager().sendNotification(
            userId,
            notifType,
            title,
            body,
            payload,
            priority
        );

        if (result) {
            callback(null, { success: true, notificationId: result.id });
        } else {
            // Notification likely blocked by preferences
            callback(null, { success: false, error: 'Blocked by user preferences' });
        }

    } catch (error: any) {
        console.error('gRPC SendNotification Error:', error);
        callback(null, { success: false, error: error.message });
    }
};

const updatePreferences = async (call: any, callback: any) => {
    // TODO: Implement preference updates via PreferenceRepository
    callback(null, { success: true });
}

export const startGrpcServer = (port: string) => {
    const server = new grpc.Server();

    server.addService(notificationProto.NotificationService.service, {
        SendNotification: sendNotification,
        UpdatePreferences: updatePreferences
    });

    const bindAddr = `0.0.0.0:${port}`;
    server.bindAsync(bindAddr, grpc.ServerCredentials.createInsecure(), (err, port) => {
        if (err) {
            console.error('Failed to bind gRPC server:', err);
            return;
        }
        console.log(`gRPC Server running at ${bindAddr}`);
        server.start();
    });
};
