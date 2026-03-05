
const path = require('node:path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
require('dotenv').config();

const PROTO_PATH = path.join(__dirname, 'proto/notification.proto');
const NOTIFICATION_SERVICE_ADDRESS = process.env.NOTIFICATION_SERVICE_ADDRESS || "localhost:50072";

console.log(`Connecting to NotificationService at: ${NOTIFICATION_SERVICE_ADDRESS}`);

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
});

const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
const NotificationService = protoDescriptor.notification.NotificationService;

const client = new NotificationService(
    NOTIFICATION_SERVICE_ADDRESS,
    grpc.credentials.createInsecure()
);

const params = {
    to: "javed@example.com", // Replace with a test email if needed
    subject: "Test Diagnostic Email",
    body: "This is a test to verify gRPC connectivity.",
    isHtml: true,
};

console.log("Sending test gRPC request...");

client.SendEmail(params, new grpc.Metadata(), (error, response) => {
    if (error) {
        console.error("gRPC Error:", error);
    } else {
        console.log("gRPC Success Response:", response);
    }
    client.close();
});
