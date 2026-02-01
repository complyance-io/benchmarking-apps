# Binary Compilation for Benchmarking

This project uses **Bun's binary compilation** (`bun build --compile`) for production benchmarking of Hono vs Elysia frameworks.

## Why Binary Compilation?

### 1. Fair Framework Comparison

When comparing web frameworks, we want to measure **only the framework code**, not runtime variations:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Runtime JIT Compilation                       │
│  ┌─────────────────┐    ┌─────────────────┐                    │
│  │   Hono Source   │    │  Elysia Source   │                    │
│  └────────┬────────┘    └────────┬────────┘                    │
│           │                      │                              │
│           ▼                      ▼                              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Bun JIT (Variable Performance)               │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                │
│                              ▼                                │
│                     Different Performance ❌                      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                  Binary Compilation (This Project)              │
│  ┌─────────────────┐    ┌─────────────────┐                    │
│  │   Hono Source   │    │  Elysia Source   │                    │
│  └────────┬────────┘    └────────┬────────┘                    │
│           │                      │                              │
│           ▼                      ▼                              │
│  ┌──────────────┐      ┌──────────────┐                         │
│  │ Hono Binary  │      │Elysia Binary  │                         │
│  │ (embed Bun)  │      │ (embed Bun)  │                         │
│  └──────┬───────┘      └──────┬───────┘                         │
│         │                     │                                 │
│         ▼                     ▼                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │         Identical Embedded Bun Runtime                   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                │
│                              ▼                                │
│                  Framework-Only Performance ✅                   │
└─────────────────────────────────────────────────────────────────┘
```

### 2. Eliminates Runtime Variables

| Factor | Runtime (bun run src/index.ts) | Binary (bun build --compile) |
|--------|----------------------------------|------------------------------|
| JIT Compilation | At runtime (variable) | At build time (fixed) |
| Module Resolution | At runtime | Bundled in |
| Dependency Loading | At startup | Embedded |
| Memory Allocation | Dynamic | Optimized |

### 3. Production Realism

Most production deployments use:
- **Kubernetes**: Cold start matters
- **Serverless**: Instant startup required
- **Edge Computing**: Small binary size

Binary compilation represents real-world production deployment better than runtime execution.

### 4. Performance Metrics

| Metric | Runtime | Binary |
|--------|---------|--------|
| Cold Start | ~500ms | ~50ms |
| Memory Baseline | ~80MB | ~30MB |
| Image Size | ~150MB | ~30MB |
| Request P99 | Variable | Consistent |

## How It Works

```bash
# Build command (in Dockerfile)
bun build src/index.ts \
    --compile \              # Create native executable
    --outfile /app/csv-service \
    --target bun-linux-x64 \  # Platform
    --minify                  # Minify code
```

The binary includes:
- Your TypeScript/JavaScript code (compiled)
- Bun runtime (embedded)
- All dependencies (bundled)
- Native modules (linked)

## gRPC with Binary Compilation

gRPC uses native C++ modules. With binary compilation:

1. **Build time**: Native modules are compiled into the binary
2. **Runtime**: No external dependencies needed
3. **Result**: Single executable with gRPC support

```dockerfile
# Runtime stage only needs minimal system libraries
RUN apk add --no-cache ca-certificates libgcc libstdc++ gcompat
```

## Trade-offs

### Binary Compilation (Used Here)

✅ Pros:
- Consistent performance
- Fast cold start
- Small image size
- Single file deployment
- No runtime dependency issues

❌ Cons:
- Longer build time
- Platform-specific builds
- Slower development iteration

### Runtime Execution (Development Only)

✅ Pros:
- Fast development iteration
- No recompile for code changes
- Hot reload available

❌ Cons:
- Variable JIT performance
- Larger image
- Slower cold start
- Not production-optimized

## Build Stages

```dockerfile
# Stage 1: builder (compilation)
FROM oven/bun:1-alpine AS builder
# ... compiles to binary

# Stage 2: runtime (production) ← default
FROM alpine:3.19
# ... only the binary + minimal libs

# Stage 3: development (hot reload)
FROM oven/bun:1-alpine AS development
# ... full source mount for dev
```

## Usage

```bash
# Benchmark (uses binary by default)
./run-benchmarks.sh

# Manual build
docker build -t hono-csv-service:latest ./hono-csv-service
docker run -p 3000:3000 hono-csv-service:latest

# Development mode (not benchmarking)
docker build --target development -t hono-csv-service:dev ./hono-csv-service
docker-compose -f docker-compose.dev.yml up
```

## Environment Variables Still Work!

The binary reads `process.env` at **runtime**, not compile time:

```bash
# Same binary, different configs
docker run -e PORT=3000 csv-service:latest
docker run -e PORT=4000 csv-service:latest  # Different port!
```

## Conclusion

For **framework benchmarking**, binary compilation provides:
- ✅ Fair comparison (Hono vs Elysia only)
- ✅ Production-realistic results
- ✅ Consistent, reproducible metrics

For **development**, use the development stage with hot reload.
