# Build Modes: Binary vs Minified vs Development

This project supports **three different build modes** for different use cases.

---

## Quick Comparison

| Mode | Command | Image Size | Cold Start | Use Case |
|------|---------|------------|------------|----------|
| **Binary** | `(default)` | ~30MB | ~50ms | Benchmarking, Production, Edge |
| **Minified** | `--target runtime` | ~80MB | ~200ms | Traditional Production, Debugging |
| **Development** | `--target development` | ~150MB | ~500ms | Local Development, Hot Reload |

---

## 1. Binary Mode (Default)

**Best for:** Benchmarking, Production deployment, Serverless, Edge computing

```bash
# Docker
docker build -t hono-csv-service:latest ./hono-csv-service
docker run -p 3000:3000 hono-csv-service:latest

# Docker Compose (default)
docker-compose -f docker-compose.otel.yml up

# Manual build
bun build src/index.ts --compile --outfile csv-service
```

### Characteristics

```
┌─────────────────────────────────────────────────────────────┐
│  Source Code (TS)  ───►  Bun Compiler  ───►  Binary       │
│                                            (single file)    │
│  ┌────────────────┐              ┌─────────────────┐             │
│  │  Hono/Elysia  │              │  Bun Embedded   │             │
│  │  Framework    │              │  Runtime         │             │
│  └────────────────┘              └─────────────────┘             │
│                                                             │
│  Result: ~30MB executable, no runtime dependencies needed  │
└─────────────────────────────────────────────────────────────┘
```

### Pros
- ✅ Fastest cold start (~50ms)
- ✅ Smallest image size (~30MB)
- ✅ Consistent performance (no JIT variability)
- ✅ Single file deployment
- ✅ Minimal attack surface

### Cons
- ❌ Longer build time
- ❌ Platform-specific builds
- ❌ Can't inspect JS in container

---

## 2. Minified Runtime Mode

**Best for:** Traditional production, when you need full Bun features

```bash
# Docker
docker build --target runtime -t hono-csv-service:runtime ./hono-csv-service
docker run -p 3000:3000 hono-csv-service:runtime

# Docker Compose
docker-compose -f docker-compose.minified.yml up
```

### Characteristics

```
┌─────────────────────────────────────────────────────────────┐
│  Source Code (TS)  ───►  Bun Bundler   ───►  Minified JS   │
│                                            + dependencies  │
│  ┌────────────────┐              ┌─────────────────┐             │
│  │  Hono/Elysia  │              │  Bun Runtime    │             │
│  │  Framework    │              │  (separate)      │             │
│  └────────────────┘              └─────────────────┘             │
│                                                             │
│  Result: ~80MB image, full Bun runtime with minified code    │
└─────────────────────────────────────────────────────────────┘
```

### Pros
- ✅ Full Bun runtime features available
- ✅ Can use Bun debugger
- ✅ Faster rebuilds than binary
- ✅ Can inspect bundled code

### Cons
- ❌ Slower cold start (~200ms)
- ❌ Larger image (~80MB)
- ❌ JIT compilation variability

---

## 3. Development Mode

**Best for:** Local development, hot reload, debugging

```bash
# Docker
docker build --target development -t hono-csv-service:dev ./hono-csv-service
docker run -p 3000:3000 -v ./src:/app/src hono-csv-service:dev

# Docker Compose
docker-compose -f docker-compose.dev.yml up
```

### Characteristics

```
┌─────────────────────────────────────────────────────────────┐
│  Source mounted directly into container                        │
│  ┌────────────────┐              ┌─────────────────┐             │
│  │  Hono/Elysia  │──────────────►│  Bun Runtime    │             │
│  │  (watch mode) │              │  Hot Reload      │             │
│  └────────────────┘              └─────────────────┘             │
│                                                             │
│  Result: Full source, instant reload, ~150MB image         │
└─────────────────────────────────────────────────────────────┘
```

### Pros
- ✅ Instant hot reload
- ✅ Full source code available
- ✅ Best DX (developer experience)
- ✅ Source maps for debugging

### Cons
- ❌ Largest image (~150MB)
- ❌ Slower cold start (~500ms)
- ❌ Not production-optimized

---

## Dockerfile Targets

```dockerfile
# Multi-stage Dockerfile

# Stage 1: Common builder
FROM oven/bun:1-alpine AS builder
... install deps, copy source ...

# Stage 2: Binary target
FROM builder AS binary
RUN bun build src/index.ts --compile --outfile csv-service

# Stage 3: Minified target
FROM builder AS minified
RUN bun build src/index.ts --outfile dist/index.js --minify

# Final: Binary (default)
FROM alpine:3.19
COPY --from=binary /app/csv-service
ENTRYPOINT ["/app/csv-service"]

# Final: Minified runtime
FROM oven/bun:1-alpine AS runtime
COPY --from=minified /app/dist
ENTRYPOINT ["bun", "run", "dist/index.js"]

# Final: Development
FROM oven/bun:1-alpine AS development
COPY . .
ENTRYPOINT ["bun", "run", "dev"]
```

---

## Docker Compose Files

| File | Mode | Target |
|------|------|--------|
| `docker-compose.otel.yml` | **Binary** | (default) |
| `docker-compose.binary.yml` | Binary (standalone) | (default) |
| `docker-compose.minified.yml` | Minified Runtime | `--target runtime` |
| `docker-compose.dev.yml` | Development | `--target development` |

---

## Usage Examples

### Build Different Variants

```bash
# Binary (benchmarking/production)
docker build -t hono-csv-service:binary ./hono-csv-service

# Minified runtime (traditional production)
docker build --target runtime -t hono-csv-service:minified ./hono-csv-service

# Development (local dev)
docker build --target development -t hono-csv-service:dev ./hono-csv-service
```

### Run Different Variants

```bash
# All three at once (different ports)
docker run -d --name hono-binary -p 3000:3000 hono-csv-service:binary
docker run -d --name hono-minified -p 3010:3000 hono-csv-service:minified
docker run -d --name hono-dev -p 3020:3000 -v $(pwd)/hono-csv-service/src:/app/src hono-csv-service:dev
```

---

## Benchmarking Scenarios

### Scenario 1: Framework Comparison (Hono vs Elysia)

**Use:** Binary mode (docker-compose.otel.yml)

Both services compiled to identical Bun runtime:
- Only difference: framework code
- Fair comparison: no JIT variations

```bash
./run-benchmarks.sh
```

### Scenario 2: Binary vs Runtime Comparison

**Use:** Compare docker-compose.otel.yml vs docker-compose.minified.yml

Measures overhead of Bun runtime vs embedded runtime:

```bash
# Terminal 1: Binary
docker-compose -f docker-compose.otel.yml up

# Terminal 2: Minified Runtime
docker-compose -f docker-compose.minified.yml up
# (change ports to avoid conflicts)
```

### Scenario 3: Production Deployment

**Choose based on your needs:**

- **Edge/Serverless** → Binary (fastest cold start)
- **Kubernetes** → Minified Runtime (easier debugging)
- **Traditional VM** → Either works

---

## Performance Characteristics

### Startup Time

```
Binary:      ████████████░ 50ms  (fastest)
Minified:    ████████████████████████ 200ms
Development: ████████████████████████████████████ 500ms
```

### Memory Usage (at rest)

```
Binary:      ████ 30MB
Minified:    ████████ 80MB
Development: ████████████████ 150MB
```

### Request P99 Latency

```
Binary:      ████████████░ 50ms  (most consistent)
Minified:    ██████████████ 60ms
Development: ████████████████ 80ms
```

---

## Environment Variables (Work for All Modes)

All three modes read `process.env` at **runtime**:

```bash
# Same binary, different configs
docker run -e PORT=3000 csv-service:binary
docker run -e PORT=4000 csv-service:binary  # Different port!
docker run -e OTEL_SAMPLE_RATIO=0.1 csv-service:binary  # Less tracing
```

---

## Recommendation

| Use Case | Recommended Mode |
|----------|------------------|
| **Framework Benchmarking** | Binary |
| **Production (most cases)** | Binary or Minified |
| **Production (need Bun features)** | Minified Runtime |
| **Edge/Serverless** | Binary |
| **Local Development** | Development |
| **CI/CD Pipeline** | Binary (smallest, fastest) |

---

## Switching Between Modes

```bash
# Default (Binary)
./run-benchmarks.sh

# Minified Runtime Benchmark
BUILD_TARGET=runtime ./run-benchmarks.sh

# Development
docker-compose -f docker-compose.dev.yml up
```
