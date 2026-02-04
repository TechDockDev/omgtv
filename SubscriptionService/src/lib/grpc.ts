import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import { loadConfig } from "../config";

const PROTO_PATH_AUTH = path.join(__dirname, "../../proto/auth.proto");
const PROTO_PATH_USER = path.join(__dirname, "../../proto/user.proto");

const packageDefinitionAuth = protoLoader.loadSync(PROTO_PATH_AUTH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
});

const packageDefinitionUser = protoLoader.loadSync(PROTO_PATH_USER, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
});

const authProto = grpc.loadPackageDefinition(packageDefinitionAuth) as any;
const userProto = grpc.loadPackageDefinition(packageDefinitionUser) as any;

let authClient: any;
let userClient: any;

export function getAuthClient() {
    if (!authClient) {
        const config = loadConfig();
        authClient = new authProto.auth.v1.AuthService(
            config.AUTH_SERVICE_ADDRESS,
            grpc.credentials.createInsecure()
        );
    }
    return authClient;
}

export function getUserClient() {
    if (!userClient) {
        const config = loadConfig();
        userClient = new userProto.user.v1.UserService(
            config.USER_SERVICE_ADDRESS,
            grpc.credentials.createInsecure()
        );
    }
    return userClient;
}
