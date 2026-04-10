import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";

const PROTO_PATH = path.join(__dirname, "../../proto/subscription.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDefinition) as any;

export class SubscriptionClient {
    private client: any;

    constructor(address: string) {
        this.client = new proto.subscription.EntitlementService(
            address,
            grpc.credentials.createInsecure()
        );
    }

    async validateEpisodeAccess(userId: string, episodeId: string): Promise<boolean> {
        return new Promise((resolve) => {
            this.client.ValidateEpisodeAccess(
                { user_id: userId, content_id: episodeId, content_type: "EPISODE" },
                (err: any, response: any) => {
                if (err) {
                    console.error("gRPC Error in SubscriptionClient:", err);
                    resolve(false); // Fail safe: deny access on error
                    return;
                }
                    resolve(Boolean(response?.allowed));
                }
            );
        });
    }
}
