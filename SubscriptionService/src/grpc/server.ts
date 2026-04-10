import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import { loadConfig } from "../config";
import {
    getUserSubscription,
    validateEpisodeAccess,
    validateReelAccess,
} from "./entitlement.grpc";

const PROTO_PATH = path.join(__dirname, "../../proto/subscription.proto");

export async function startGrpcServer() {
    const config = loadConfig();
    const server = new grpc.Server();

    const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
    });

    const proto = grpc.loadPackageDefinition(packageDefinition) as any;

    server.addService(proto.subscription.EntitlementService.service, {
        ValidateReelAccess: validateReelAccess,
        ValidateEpisodeAccess: validateEpisodeAccess,
        GetUserSubscription: getUserSubscription,
    });

    return new Promise<grpc.Server>((resolve, reject) => {
        server.bindAsync(
            config.GRPC_BIND_ADDRESS,
            grpc.ServerCredentials.createInsecure(),
            (error, port) => {
                if (error) {
                    reject(error);
                    return;
                }
                server.start();
                console.log(`🚀 gRPC Entitlement Server running at ${config.GRPC_BIND_ADDRESS}`);
                resolve(server);
            }
        );
    });
}
