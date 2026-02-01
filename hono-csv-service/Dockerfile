# Dockerfile for Hono CSV Service
# Multiple build targets for different use cases
#
# AVAILABLE TARGETS:
# ===================
# (default)  → Binary - Standalone executable, ~30MB, fastest startup
# minified   → Runtime with minified code, ~80MB, full Bun features
# development → Hot reload for local development
# ============================================================================

# ============================================================================
# Common Builder - Shared by binary and minified stages
# ============================================================================
FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++ git

# Copy package files
COPY package.json bun.lockb* ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# ============================================================================
# TARGET: binary (default) - Standalone Executable
# ============================================================================
FROM builder AS binary

# Compile to standalone binary
# --compile: Creates native executable
# --outfile: Output binary path
# --target: Platform target
# --minify: Minify code
# Compile to standalone binary (detects target architecture automatically)
RUN bun build src/index.ts \
    --compile \
    --outfile /app/csv-service \
    --minify

# Verify binary was created
RUN ls -lh /app/csv-service || (echo "Binary not found" && exit 1)

# ============================================================================
# TARGET: runtime - Minified Code with Bun Runtime
# ============================================================================
FROM builder AS minified

# Minify (no compile) - outputs JS that runs with Bun
RUN bun build src/index.ts \
    --outfile /app/dist/index.js \
    --target bun \
    --minify

# Verify minified file was created
RUN ls -lh /app/dist/index.js

# ============================================================================
# FINAL: binary-production - Production Binary Image (~30MB)
# ============================================================================
FROM alpine:3.19 AS binary-production

# Install minimal runtime libraries for gRPC/networking
RUN apk add --no-cache \
    ca-certificates \
    libgcc \
    libstdc++ \
    gcompat \
    && rm -rf /var/cache/apk/*

# Create non-root user
RUN addgroup -g 1001 -S nonroot && \
    adduser -S -D -H -u 1001 -s /sbin/nologin -G nonroot -g nonroot nonroot

WORKDIR /app

# Copy ONLY the binary from builder
COPY --from=binary --chown=nonroot:nonroot /app/csv-service ./csv-service

# Copy proto files for gRPC
COPY --from=binary --chown=nonroot:nonroot /app/proto ./proto

# Create tmp directory
RUN mkdir -p /app/tmp && chown -R nonroot:nonroot /app

# Set environment variables
ENV NODE_ENV=production \
    PORT=3000 \
    GRPC_PORT=50051 \
    SERVICE_NAME=csv-service-hono \
    SERVICE_VERSION=1.0.0 \
    BUILD_TYPE=binary

# Expose ports
EXPOSE 3000 50051

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Switch to non-root user
USER nonroot:nonroot

# Run the compiled binary (no Bun runtime needed!)
ENTRYPOINT ["/app/csv-service"]

# ============================================================================
# FINAL: minified - Production Runtime Image (~80MB)
# ============================================================================
FROM oven/bun:1-alpine AS runtime

RUN apk add --no-cache ca-certificates

WORKDIR /app

# Copy package files
COPY package.json bun.lockb* ./

# Install production dependencies only
RUN bun install --frozen-lockfile --production

# Copy minified source and proto
COPY --from=minified /app/dist ./dist
COPY --from=minified /app/proto ./proto

# Create non-root user and entrypoint wrapper
RUN addgroup -g 1001 -S nonroot && \
    adduser -S -D -H -u 1001 -s /sbin/nologin -G nonroot -g nonroot nonroot && \
    chown -R nonroot:nonroot /app

# Create entrypoint wrapper (before user switch)
RUN echo '#!/bin/sh' > /app/entrypoint.sh && \
    echo 'exec bun dist/index.js' >> /app/entrypoint.sh && \
    chmod +x /app/entrypoint.sh && \
    chown nonroot:nonroot /app/entrypoint.sh

# Set environment variables
ENV NODE_ENV=production \
    BUN_RUNTIME_NODE=1 \
    PORT=3000 \
    GRPC_PORT=50051 \
    SERVICE_NAME=csv-service-hono \
    SERVICE_VERSION=1.0.0 \
    BUILD_TYPE=minified-runtime

# Expose ports
EXPOSE 3000 50051

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Switch to non-root user
USER nonroot:nonroot

# Run minified code with Bun runtime
ENTRYPOINT ["/app/entrypoint.sh"]

# ============================================================================
# FINAL: development - Local Development with Hot Reload
# ============================================================================
FROM oven/bun:1-alpine AS development

WORKDIR /app

RUN apk add --no-cache ca-certificates git

COPY package.json bun.lockb* ./
RUN bun install

COPY . .

ENV NODE_ENV=development \
    BUILD_TYPE=development

EXPOSE 3000 50051

CMD ["bun", "run", "dev"]
