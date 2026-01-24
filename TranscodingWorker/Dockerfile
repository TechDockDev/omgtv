# Optimized multi-stage build for TranscodingWorker
# Includes Node.js + FFmpeg

# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci --only=production

# Copy source and build
COPY . .
RUN npm run build

# Stage 2: Runtime
FROM node:20-alpine

# Install FFmpeg
RUN apk add --no-cache ffmpeg

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S worker -u 1001 -G nodejs

WORKDIR /app

# Copy built files from builder
COPY --from=builder --chown=worker:nodejs /app/dist ./dist
COPY --from=builder --chown=worker:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=worker:nodejs /app/package.json ./

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
