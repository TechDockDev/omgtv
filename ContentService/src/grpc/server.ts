import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../config";
import { buildStubContentResponse } from "../services/content";

const { ServerCredentials, status } = grpc;

type Server = grpc.Server;
type Metadata = grpc.Metadata;

type ContentPackageDefinition = ReturnType<
  typeof grpc.loadPackageDefinition
> & {
  content: {
    v1: {
      ContentService: grpc.ServiceClientConstructor & {
        service: grpc.ServiceDefinition;
      };
    };
  };
};

const PROTO_PATH = path.join(__dirname, "../../proto/content.proto");

type GetVideoMetadataRequest = {
  video_id?: string;
};

type GetVideoMetadataResponse = {
  id: string;
  title: string;
  description: string;
  duration_seconds: number;
  owner_id: string;
  published_at: string;
  visibility: string;
  tags: string[];
  thumbnails: Array<{
    url: string;
    width: number;
    height: number;
  }>;
  stats: {
    views: number;
    likes: number;
    comments: number;
  };
};

type UnaryHandler<Req, Res> = grpc.handleUnaryCall<Req, Res>;

function loadContentPackage(): ContentPackageDefinition {
  const definition = loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  return grpc.loadPackageDefinition(definition) as ContentPackageDefinition;
}

function isAuthorized(metadata: Metadata, serviceToken?: string) {
  if (!serviceToken) {
    return true;
  }
  const header = metadata.get("authorization")[0];
  if (typeof header !== "string") {
    return false;
  }
  return header.replace(/^Bearer\s+/i, "") === serviceToken;
}

const permissionDenied = (message: string) => {
  const error = new Error(message) as grpc.ServiceError;
  error.code = status.PERMISSION_DENIED;
  return error;
};

const invalidArgument = (message: string) => {
  const error = new Error(message) as grpc.ServiceError;
  error.code = status.INVALID_ARGUMENT;
  return error;
};

export async function startGrpcServer(app: FastifyInstance): Promise<Server> {
  const config = loadConfig();
  const contentPackage = loadContentPackage();
  const server = new grpc.Server();

  const getVideoMetadata: UnaryHandler<
    GetVideoMetadataRequest,
    GetVideoMetadataResponse
  > = async (call, callback) => {
    if (!isAuthorized(call.metadata, config.SERVICE_AUTH_TOKEN)) {
      callback(permissionDenied("Unauthorized"));
      return;
    }

    const videoId = call.request.video_id;
    if (!videoId) {
      callback(invalidArgument("video_id is required"));
      return;
    }

    const response = buildStubContentResponse({
      id: videoId,
      cdnBaseUrl: config.CDN_BASE_URL,
      defaultOwnerId: config.DEFAULT_OWNER_ID,
    });

    callback(null, {
      id: response.id,
      title: response.title,
      description: response.description ?? "",
      duration_seconds: response.durationSeconds,
      owner_id: response.ownerId,
      published_at: response.publishedAt,
      visibility: response.visibility,
      tags: response.tags,
      thumbnails: response.thumbnails.map((thumbnail) => ({
        url: thumbnail.url,
        width: thumbnail.width,
        height: thumbnail.height,
      })),
      stats: {
        views: response.stats.views,
        likes: response.stats.likes,
        comments: response.stats.comments,
      },
    });
  };

  server.addService(contentPackage.content.v1.ContentService.service, {
    GetVideoMetadata: getVideoMetadata,
  });

  await new Promise<void>((resolve, reject) => {
    server.bindAsync(
      config.GRPC_BIND_ADDRESS,
      ServerCredentials.createInsecure(),
      (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      }
    );
  });

  server.start();
  app.log.info({ bind: config.GRPC_BIND_ADDRESS }, "Content gRPC listening");
  return server;
}

export async function stopGrpcServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.tryShutdown((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}
