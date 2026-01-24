import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import pino from "pino";
import { ABR_PROFILES, type Rendition, type TranscodeResult } from "./types.js";
import type { Config } from "./config.js";

/**
 * FFmpeg transcoding service
 * Converts source video to HLS with ABR (4 quality levels)
 * Handles both portrait and landscape videos
 */
export class FFmpegService {
    private readonly logger: pino.Logger;
    private readonly config: Config;

    constructor(config: Config, logger: pino.Logger) {
        this.config = config;
        this.logger = logger.child({ component: "ffmpeg" });
    }

    /**
     * Transcode video to HLS with ABR using single-pass encoding
     */
    async transcode(
        sourcePath: string,
        outputDir: string,
        contentId: string
    ): Promise<TranscodeResult> {
        this.logger.info({ sourcePath, outputDir, contentId }, "Starting transcode");

        // Create output directory
        await mkdir(outputDir, { recursive: true });

        // Get video info first
        const videoInfo = await this.probeVideo(sourcePath);
        this.logger.info({ videoInfo }, "Video info detected");

        const isPortrait = videoInfo.height > videoInfo.width;
        this.logger.info({ isPortrait }, "Video orientation detected");

        // Determine which profiles to use based on source resolution
        const profiles = this.selectProfiles(videoInfo.width, videoInfo.height);
        this.logger.info(
            { profiles: profiles.map((p) => p.name) },
            "Selected ABR profiles"
        );

        // Transcode to HLS with all ABR variants in single pass
        await this.transcodeToHLS(sourcePath, outputDir, profiles, isPortrait);

        // Generate thumbnail
        const thumbnailPath = await this.generateThumbnail(
            sourcePath,
            outputDir,
            videoInfo.durationSeconds
        );

        // Calculate checksum of master playlist
        const masterPath = join(outputDir, "master.m3u8");
        const checksum = await this.calculateChecksum(masterPath);

        const result: TranscodeResult = {
            manifestPath: `${contentId}/master.m3u8`,
            manifestUrl: "", // Will be set by caller with CDN URL
            thumbnailPath: thumbnailPath ? `${contentId}/thumbnail.jpg` : undefined,
            durationSeconds: videoInfo.durationSeconds,
            renditions: profiles,
            checksum,
        };

        this.logger.info({ result }, "Transcode complete");
        return result;
    }

    /**
     * Probe video for metadata
     */
    private async probeVideo(
        sourcePath: string
    ): Promise<{ width: number; height: number; durationSeconds: number }> {
        return new Promise((resolve, reject) => {
            const args = [
                "-v", "quiet",
                "-print_format", "json",
                "-show_format",
                "-show_streams",
                sourcePath,
            ];

            const proc = spawn("ffprobe", args);
            let stdout = "";
            let stderr = "";

            proc.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
            proc.stderr.on("data", (data: Buffer) => (stderr += data.toString()));

            proc.on("close", (code) => {
                if (code !== 0) {
                    reject(new Error(`ffprobe failed: ${stderr}`));
                    return;
                }

                try {
                    const info = JSON.parse(stdout);
                    const videoStream = info.streams.find(
                        (s: { codec_type: string }) => s.codec_type === "video"
                    );

                    resolve({
                        width: videoStream?.width ?? 1920,
                        height: videoStream?.height ?? 1080,
                        durationSeconds: parseFloat(info.format?.duration ?? "0"),
                    });
                } catch (e) {
                    reject(new Error(`Failed to parse ffprobe output: ${e}`));
                }
            });
        });
    }

    /**
     * Select appropriate ABR profiles based on source resolution
     * Handles both portrait and landscape videos
     */
    private selectProfiles(sourceWidth: number, sourceHeight: number): Rendition[] {
        // Use the longer dimension for comparison to handle portrait videos
        const sourceLong = Math.max(sourceWidth, sourceHeight);
        const sourceShort = Math.min(sourceWidth, sourceHeight);

        const profiles = ABR_PROFILES.filter((profile) => {
            const profileLong = Math.max(profile.width, profile.height);
            const profileShort = Math.min(profile.width, profile.height);
            return profileLong <= sourceLong && profileShort <= sourceShort;
        });

        // Always include at least one profile (lowest quality)
        if (profiles.length === 0) {
            this.logger.warn(
                { sourceWidth, sourceHeight },
                "No matching profiles, using lowest quality"
            );
            return [ABR_PROFILES[ABR_PROFILES.length - 1]]; // 360p
        }

        return profiles;
    }

    /**
     * Transcode to HLS with all ABR variants in a single FFmpeg pass
     */
    private async transcodeToHLS(
        sourcePath: string,
        outputDir: string,
        profiles: Rendition[],
        isPortrait: boolean
    ): Promise<void> {
        this.logger.info({ profiles: profiles.map(p => p.name), isPortrait }, "Building HLS transcode command");

        // Build filter_complex for splitting and scaling
        const numProfiles = profiles.length;
        const splitOutputs = profiles.map((_, i) => `[v${i}]`).join("");

        // Build scale filters - swap dimensions for portrait videos
        const scaleFilters = profiles.map((profile, i) => {
            const w = isPortrait ? profile.height : profile.width;
            const h = isPortrait ? profile.width : profile.height;
            return `[v${i}]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2[v${profile.name}]`;
        }).join("; ");

        const filterComplex = `[0:v]split=${numProfiles}${splitOutputs}; ${scaleFilters}`;

        // Create subdirectories for each stream
        for (const profile of profiles) {
            await mkdir(join(outputDir, profile.name), { recursive: true });
        }

        // Build map arguments
        const mapArgs: string[] = [];
        profiles.forEach((profile, i) => {
            mapArgs.push("-map", `[v${profile.name}]`);
        });
        // Add audio mapping for each video stream
        for (let i = 0; i < profiles.length; i++) {
            mapArgs.push("-map", "0:a?");
        }

        // Build video codec args per stream with mobile optimizations
        const codecArgs: string[] = [];
        profiles.forEach((profile, i) => {
            codecArgs.push(
                `-c:v:${i}`, "libx264",
                `-b:v:${i}`, `${profile.bitrateKbps}k`,
                `-maxrate:v:${i}`, `${Math.round(profile.bitrateKbps * 1.1)}k`,
                `-bufsize:v:${i}`, `${profile.bitrateKbps * 2}k`
            );
        });

        // Build audio codec args per stream (different bitrates per quality)
        const audioArgs: string[] = [];
        profiles.forEach((profile, i) => {
            const audioBitrate = profile.audioBitrateKbps ?? 128;
            audioArgs.push(
                `-c:a:${i}`, "aac",
                `-b:a:${i}`, `${audioBitrate}k`,
                `-ac:a:${i}`, "2"
            );
        });

        // Build var_stream_map with names for automatic folder naming
        const varStreamMap = profiles.map((p, i) => `v:${i},a:${i},name:${p.name}`).join(" ");

        // Network optimization: Use shorter segment duration for faster initial playback
        const segmentDuration = this.config.HLS_SEGMENT_DURATION ?? 4;
        const gopSize = segmentDuration * 30; // 30 FPS aligned with segment

        const args = [
            "-y",
            "-i", sourcePath,
            "-filter_complex", filterComplex,
            ...mapArgs,
            ...codecArgs,
            ...audioArgs,
            // === MOBILE OPTIMIZATIONS ===
            "-r", "30",
            "-bf", "2",
            "-preset", "veryfast",
            "-tune", "fastdecode",
            "-profile:v", "main",
            "-level", "4.0",
            // === KEYFRAME ALIGNMENT ===
            "-g", String(gopSize),
            "-keyint_min", String(gopSize),
            "-sc_threshold", "0",
            "-force_key_frames", `expr:gte(t,n_forced*${segmentDuration})`,
            // === HLS SETTINGS WITH fMP4 SEGMENTS ===
            "-hls_time", String(segmentDuration),
            "-hls_playlist_type", "vod",
            "-hls_segment_type", "fmp4",
            "-hls_fmp4_init_filename", "init.mp4", // Relative to variant playlist
            // Enable independent segments for transition-less playback
            "-hls_flags", "independent_segments",
            "-hls_start_number_source", "generic",
            "-master_pl_name", "master.m3u8", // Places it in the same dir as the variants base
            "-var_stream_map", varStreamMap,
            "-hls_segment_filename", join(outputDir, "%v/segment_%03d.m4s"),
            join(outputDir, "%v/playlist.m3u8"),
        ];

        this.logger.info({ args: args.join(" ") }, "Running FFmpeg command");
        await this.runFFmpeg(args);

        this.logger.info({ outputDir }, "HLS transcoding complete");
    }



    /**
     * Generate thumbnail from video
     */
    private async generateThumbnail(
        sourcePath: string,
        outputDir: string,
        durationSeconds: number
    ): Promise<string | null> {
        try {
            const thumbnailPath = join(outputDir, "thumbnail.jpg");
            const seekTime = Math.min(durationSeconds * 0.1, 5); // 10% or 5s max

            const args = [
                "-y",
                "-ss", String(seekTime),
                "-i", sourcePath,
                "-vframes", "1",
                "-vf", "scale=640:-1",
                "-q:v", "2",
                thumbnailPath,
            ];

            await this.runFFmpeg(args);
            this.logger.info({ thumbnailPath }, "Thumbnail generated");
            return thumbnailPath;
        } catch (e) {
            this.logger.warn({ error: e }, "Failed to generate thumbnail");
            return null;
        }
    }

    /**
     * Run FFmpeg command
     */
    private runFFmpeg(args: string[], options: { cwd?: string } = {}): Promise<void> {
        return new Promise((resolve, reject) => {
            this.logger.debug({ args: args.join(" "), cwd: options.cwd }, "Running FFmpeg");

            const proc = spawn("ffmpeg", args, { cwd: options.cwd });
            let stderr = "";

            proc.stderr.on("data", (data: Buffer) => {
                stderr += data.toString();
            });

            proc.on("close", (code: number | null) => {
                if (code !== 0) {
                    this.logger.error({ code, stderr: stderr.slice(-2000) }, "FFmpeg failed");
                    reject(new Error(`FFmpeg failed with code ${code}`));
                } else {
                    resolve();
                }
            });

            proc.on("error", (error: Error) => {
                reject(new Error(`FFmpeg spawn error: ${error.message}`));
            });
        });
    }

    /**
     * Calculate SHA256 checksum of a file
     */
    private async calculateChecksum(filePath: string): Promise<string> {
        const content = await readFile(filePath);
        return createHash("sha256").update(content).digest("hex");
    }
}
