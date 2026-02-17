# Optimized multi-stage build for TranscodingWorker
# Includes Node.js + FFmpeg

# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies for build (including devDependencies like typescript)
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Stage 2: Runtime
FROM node:20-alpine

# Install FFmpeg and OpenSSL (required for Prisma on Alpine)
RUN apk add --no-cache ffmpeg openssl

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S worker -u 1001 -G nodejs

WORKDIR /app

# Copy built files from builder
# Copy built files from builder
COPY --from=builder /app/package*.json ./
# Need schema to generate client
COPY --from=builder /app/prisma ./prisma

# Install prod deps and generate prisma client
RUN npm ci && npx prisma generate

COPY --from=builder /app/dist ./dist

# Create temp directory for transcoding
RUN mkdir -p /tmp/transcode && chown worker:nodejs /tmp/transcode

# Switch to non-root user
USER worker

# Environment defaults
ENV NODE_ENV=production
ENV TRANSCODE_TEMP_DIR=/tmp/transcode
ENV LOG_LEVEL=info

# Health check (optional - worker is long-running)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "console.log('healthy')" || exit 1

# Start the worker
CMD ["node", "dist/index.js"]
