# CSV Processing Microservices - Framework Benchmark

Production-ready microservices for CSV/Excel file processing, built with **Bun.js** runtime. Two identical implementations - one with **Hono**, one with **Elysia** - for fair framework performance comparison.

> **⚡ Binary Compilation**: This project uses `bun build --compile` for benchmarking. Both services are compiled to standalone binaries, ensuring **apples-to-apples** framework comparison by eliminating runtime JIT variations. See [BINARY_COMPILATION.md](./BINARY_COMPILATION.md) for details.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Kubernetes Cluster                            │
│                                                                         │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐   │
│  │ Ingress         │    │ Service Mesh    │    │ OTEL Stack      │   │
│  │ (Nginx/Traefik) │    │ (Consul)        │    │ (Jaeger/Prom)   │   │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘   │
│           │                      │                       │             │
│           └──────────────────────┼───────────────────────┘             │
│                                  ▼                                     │
│         ┌──────────────────────────────────────┐                       │
│         │         API Gateway / LB             │                       │
│         └──────────────────────────────────────┘                       │
│                    │             │                                     │
│         ┌──────────┴─────┐ ┌────┴──────────┐                          │
│         │                │ │               │                          │
│  ┌──────▼──────┐   ┌────▼────┐   ┌───────▼──────┐                    │
│  │   Hono      │   │ Elysia  │   │   Hono       │                    │
│  │ CSV Service │   │ CSV     │   │ CSV Service  │                    │
│  │ (HTTP+gRPC) │   │ Service │   │ (HTTP+gRPC)  │                    │
│  └─────────────┘   └─────────┘   └──────────────┘                    │
│         │                │               │                             │
│         └────────────────┼───────────────┘                             │
│                          ▼                                             │
│         ┌──────────────────────────────────────┐                       │
│         │         Redis (Rate Limiting)        │                       │
│         └──────────────────────────────────────┘                       │
└─────────────────────────────────────────────────────────────────────────┘
```

## Services

| Service | Framework | Port | gRPC Port |
|---------|-----------|------|-----------|
| Hono CSV Service | Hono | 3000 | 50051 |
| Elysia CSV Service | Elysia | 3001 | 50052 |

## Features

- **File Processing**: Parse CSV/XLSX up to 100MB
- **gRPC**: ProcessFile RPC with streaming support
- **OTEL**: Tracing, metrics, logs via OTLP/HTTP
- **Service Discovery**: Consul health checks + KV config
- **Security**: JWT auth, RBAC, rate limiting, CORS
- **Observability**: Jaeger, Prometheus, Grafana, Loki
- **Kubernetes**: HPA, PDB, NetworkPolicy, distroless images

## Quick Start

```bash
# Start full OTEL stack with both services
docker-compose -f docker-compose.otel.yml up -d

# View services
curl http://localhost:3000/health
curl http://localhost:3001/health

# Observability UIs
open http://localhost:16686  # Jaeger (traces)
open http://localhost:9090   # Prometheus (metrics)
open http://localhost:3000   # Grafana (dashboards)
open http://localhost:8500   # Consul (service catalog)
```

## API Usage

```bash
# Generate sample JWT
export JWT_TOKEN=$(curl -s http://localhost:3000/token -u admin:admin)

# Upload CSV to Hono service
curl -X POST http://localhost:3000/api/v1/import \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -F "file=@sample.csv"

# Upload CSV to Elysia service
curl -X POST http://localhost:3001/api/v1/import \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -F "file=@sample.csv"

# gRPC call (using grpcurl)
grpcurl -plaintext -d '{"file_data":"...","file_type":"csv"}' \
  localhost:50051 csvservice.CSVService/ProcessFile
```

## Benchmarking

### One-Command Benchmark

```bash
# Run full benchmark (builds, starts services, runs tests, generates report)
./run-benchmarks.sh

# Custom configuration
./run-benchmarks.sh --vus 1000 --duration 5m

# Skip OTEL stack (faster)
./run-benchmarks.sh --skip-otel --no-cleanup

# See all options
./run-benchmarks.sh --help
```

### Manual Benchmarking

```bash
# Start services first
docker-compose -f docker-compose.otel.yml up -d

# Run comparative load test
k6 run --out json=results.json benchmark/k6-load-test.js
```

### Target Metrics

| Metric | Target |
|--------|--------|
| P95 Latency | < 2s |
| P99 Latency | < 5s |
| Success Rate | > 99% |
| Memory (100K rows) | < 500Mi |
| Throughput | > 1000 req/s |

## Deployment

### Local (Docker Compose)

```bash
docker-compose -f docker-compose.otel.yml up
```

### Kubernetes

```bash
# Create namespace
kubectl create namespace csv-services

# Deploy Hono service
kubectl apply -f hono-csv-service/k8s-manifests/ -n csv-services

# Deploy Elysia service
kubectl apply -f elysia-csv-service/k8s-manifests/ -n csv-services

# Check status
kubectl get pods -n csv-services
kubectl get svc -n csv-services
```

### Build & Push Images

```bash
# Hono Service
docker build -t your-registry/hono-csv-service:v1.0.0 ./hono-csv-service
docker push your-registry/hono-csv-service:v1.0.0

# Elysia Service
docker build -t your-registry/elysia-csv-service:v1.0.0 ./elysia-csv-service
docker push your-registry/elysia-csv-service:v1.0.0
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `SERVICE_NAME` | - | Service name for OTEL/Consul |
| `FRAMEWORK` | - | Framework name (hono/elysia) |
| `PORT` | 3000 | HTTP server port |
| `GRPC_PORT` | 50051 | gRPC server port |
| `JWT_SECRET` | - | JWT signing secret |
| `OTEL_COLLECTOR_ENDPOINT` | http://otel-collector:4318 | OTEL collector |
| `CONSUL_ENABLED` | true | Enable Consul |
| `REDIS_ENABLED` | true | Enable Redis rate limiting |

## Project Structure

```
benchmarking-apps/
├── hono-csv-service/
│   ├── src/
│   │   ├── handlers/          # REST + gRPC handlers
│   │   ├── middleware/        # Auth, rate-limit, security
│   │   ├── rpc/              # gRPC client
│   │   ├── telemetry/        # OTEL setup
│   │   ├── discovery/        # Consul client
│   │   ├── utils/            # CSV parser
│   │   ├── types.ts          # Zod schemas
│   │   └── index.ts          # Entry point
│   ├── proto/                # Protocol buffers
│   ├── benchmark/            # k6 scripts
│   ├── k8s-manifests/        # Kubernetes YAMLs
│   ├── Dockerfile
│   └── package.json
│
├── elysia-csv-service/
│   └── ... (identical structure)
│
├── config/                   # OTEL, Prometheus, Grafana configs
├── docker-compose.otel.yml   # Full stack
└── README.md
```

## Observability Stack

| Component | Port | Description |
|-----------|------|-------------|
| Jaeger | 16686 | Distributed tracing UI |
| Prometheus | 9090 | Metrics storage |
| Grafana | 3000 | Dashboards |
| Loki | 3100 | Log aggregation |
| Consul | 8500 | Service discovery |
| Redis | 6379 | Rate limiting |

## Development

```bash
# Hono Service
cd hono-csv-service
bun install
bun run dev  # http://localhost:3000

# Elysia Service
cd elysia-csv-service
bun install
bun run dev  # http://localhost:3001
```

## Security

- **Authentication**: JWT with RS256 signing
- **Authorization**: RBAC with scopes (csv:read, csv:process, csv:admin)
- **Rate Limiting**: Redis-backed sliding window (100 req/min default)
- **CORS**: Configurable origins
- **Headers**: CSP, HSTS, X-Frame-Options
- **Docker**: Distroless base, non-root user

## License

MIT
