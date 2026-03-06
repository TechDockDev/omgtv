import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../config";

interface SendEmailRequest {
    to: string;
    subject: string;
    body: string;
    isHtml: boolean;
}

interface SendNotificationResponse {
    success: boolean;
    notificationId?: string;
    error?: string;
}

interface NotificationServiceClient extends grpc.Client {
    SendEmail(
        request: SendEmailRequest,
        metadata: grpc.Metadata,
        callback: (error: grpc.ServiceError | null, response: SendNotificationResponse) => void
    ): void;
}

const PROTO_PATH = path.join(__dirname, "../../proto/notification.proto");

const notificationServicePlugin = fp(async function notificationServicePlugin(
    fastify: FastifyInstance
) {
    const config = loadConfig();
    const NOTIFICATION_SERVICE_ADDRESS = config.NOTIFICATION_SERVICE_ADDRESS;

    const packageDefinition = loadSync(PROTO_PATH, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
    });

    const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;
    const client = new protoDescriptor.notification.NotificationService(
        NOTIFICATION_SERVICE_ADDRESS,
        grpc.credentials.createInsecure()
    ) as NotificationServiceClient;

    const notificationService = {
        sendEmail: (params: SendEmailRequest): Promise<SendNotificationResponse> => {
            return new Promise((resolve, reject) => {
                const metadata = new grpc.Metadata();
                // Match the case of the method in the proto (SendEmail) because keepCase: true is used
                client.SendEmail(params, metadata, (error, response) => {
                    if (error) {
                        return reject(error);
                    }
                    resolve(response);
                });
            });
        }
    };

    fastify.decorate("notificationService", notificationService);

    fastify.addHook("onClose", async () => {
        client.close();
    });
});

declare module "fastify" {
    interface FastifyInstance {
        notificationService: {
            sendEmail(params: SendEmailRequest): Promise<SendNotificationResponse>;
        };
    }
}

export default notificationServicePlugin;
