import { Storage } from "@google-cloud/storage";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { pipeline } from "node:stream/promises";
import pino from "pino";
import type { Config } from "./config.js";

/**
 * GCS Storage client for downloading source videos and uploading HLS output
 */
export class StorageClient {
    private readonly storage: Storage;
    private readonly logger: pino.Logger;
    private readonly config: Config;

    constructor(config: Config, logger: pino.Logger) {
        this.storage = new Storage({ projectId: config.GCP_PROJECT_ID });
        this.config = config;
        this.logger = logger.child({ component: "storage" });
    }

    /**
     * Download source video from GCS to local temp directory
     */
    async downloadSource(
        bucket: string,
        objectPath: string,
        localPath: string
    ): Promise<void> {
        this.logger.info({ bucket, objectPath, localPath }, "Downloading source video");

        const [file] = await this.storage
            .bucket(bucket)
            .file(objectPath)
            .download({ destination: localPath });

        this.logger.info({ localPath }, "Source video downloaded");
    }
    /**
     * Delete a file from GCS
     */
    async deleteFile(bucket: string, objectPath: string): Promise<void> {
        this.logger.info({ bucket, objectPath }, "Deleting source file");
        try {
            await this.storage.bucket(bucket).file(objectPath).delete();
            this.logger.info({ bucket, objectPath }, "Source file deleted");
        } catch (error) {
            this.logger.error({ error, bucket, objectPath }, "Failed to delete source file");
            // We don't throw here to avoid failing the whole job if cleanup fails
        }
    }

    /**
     * Upload HLS files from local directory to GCS
     */
    async uploadHlsDirectory(
        localDir: string,
        bucket: string,
        prefix: string
    ): Promise<string[]> {
        this.logger.info({ localDir, bucket, prefix }, "Uploading HLS files");

        const files = await this.listFilesRecursive(localDir);
        const uploadedPaths: string[] = [];

        for (const localFile of files) {
            const relativePath = localFile.replace(localDir, "").replace(/^[/\\]/, "");
            const gcsPath = `${prefix}/${relativePath}`.replace(/\\/g, "/");

            await this.storage.bucket(bucket).upload(localFile, {
                destination: gcsPath,
                metadata: {
                    cacheControl: this.getCacheControl(relativePath),
                    contentType: this.getContentType(relativePath),
                },
            });

            uploadedPaths.push(gcsPath);
            this.logger.debug({ localFile, gcsPath }, "Uploaded file");
        }

        this.logger.info(
            { count: uploadedPaths.length, prefix },
            "HLS upload complete"
        );

        return uploadedPaths;
    }

    /**
     * Get public URL for an object (via CDN)
     */
    getCdnUrl(objectPath: string): string {
        return `${this.config.CDN_BASE_URL}/${objectPath}`;
    }

    /**
     * Get GCS URL for an object
     */
    getGcsUrl(bucket: string, objectPath: string): string {
        return `gs://${bucket}/${objectPath}`;
    }

    /**
     * Parse gs:// URL into bucket and object
     */
    parseGcsUrl(gcsUrl: string): { bucket: string; object: string } {
        const match = gcsUrl.match(/^gs:\/\/([^/]+)\/(.+)$/);
        if (!match) {
            throw new Error(`Invalid GCS URL: ${gcsUrl}`);
        }
        return { bucket: match[1], object: match[2] };
    }

    /**
     * List all files in a directory recursively
     */
    private async listFilesRecursive(dir: string): Promise<string[]> {
        const entries = await readdir(dir, { withFileTypes: true });
        const files: string[] = [];

        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
                files.push(...(await this.listFilesRecursive(fullPath)));
            } else {
                files.push(fullPath);
            }
        }

        return files;
    }

    /**
     * Get appropriate cache control for HLS files
     */
    private getCacheControl(filename: string): string {
        if (filename.endsWith(".m3u8")) {
            // Manifests: short cache (for live updates)
            return "public, max-age=2, s-maxage=2";
        }
        if (filename.endsWith(".ts")) {
            // Segments: long cache (immutable)
            return "public, max-age=31536000, immutable";
        }
        return "public, max-age=3600";
    }

    /**
     * Get content type for HLS files
     */
    private getContentType(filename: string): string {
        if (filename.endsWith(".m3u8")) {
            return "application/vnd.apple.mpegurl";
        }
        if (filename.endsWith(".ts")) {
            return "video/mp2t";
        }
        if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) {
            return "image/jpeg";
        }
        if (filename.endsWith(".png")) {
            return "image/png";
        }
        return "application/octet-stream";
    }
}
