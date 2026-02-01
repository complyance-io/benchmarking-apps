# Hono CSV Service

Production-ready CSV/Excel file processing microservice built with Bun.js and Hono framework.

## Features

- **CSV/Excel Processing**: Parse and aggregate data from CSV and XLSX files
- **gRPC Support**: ProcessFile RPC for inter-service communication
- **OpenTelemetry**: Full tracing and metrics with OTLP export
- **Service Discovery**: Consul integration for health checks and KV config
- **Security**: JWT auth with RBAC, rate limiting, CORS, security headers
- **Kubernetes Ready**: Health probes, HPA, NetworkPolicy, distroless Docker images

## Quick Start

```bash
# Install dependencies
bun install

# Run development server
bun run dev

# Build for production
bun run build

# Run production server
bun start
```

## Docker

```bash
# Build image
docker build -t hono-csv-service:latest .

# Run container
docker run -p 3000:3000 -p 50051:50051 hono-csv-service:latest
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check (readiness probe) |
| GET | `/live` | Liveness probe |
| GET | `/ready` | Readiness probe |
| GET | `/metrics` | Service metrics |
| POST | `/api/v1/import` | Upload and process CSV/Excel file |
| POST | `/api/v1/batch` | Batch file upload |

## gRPC Service

**Port**: 50051

```protobuf
service CSVService {
  rpc ProcessFile (ProcessFileRequest) returns (ProcessFileResponse);
  rpc HealthCheck (HealthCheckRequest) returns (HealthCheckResponse);
}
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `SERVICE_NAME` | csv-service-hono | Service name for OTEL |
| `PORT` | 3000 | HTTP server port |
| `GRPC_PORT` | 50051 | gRPC server port |
| `JWT_SECRET` | - | JWT signing secret |
| `OTEL_COLLECTOR_ENDPOINT` | http://otel-collector:4318 | OTEL collector URL |
| `CONSUL_HOST` | localhost | Consul host |
| `REDIS_HOST` | localhost | Redis host |
| `MAX_FILE_SIZE` | 104857600 | Max file size in bytes |

## Authentication

The service uses JWT Bearer tokens with scopes:

- `csv:read` - Read access
- `csv:process` - Process files
- `csv:admin` - Admin access

```bash
curl -X POST http://localhost:3000/api/v1/import \
  -H "Authorization: Bearer <token>" \
  -F "file=@data.csv"
```

## Deployment

```bash
# Kubernetes
kubectl apply -f k8s-manifests/

# With Docker Compose (includes OTEL stack)
docker-compose -f ../docker-compose.otel.yml up hono-csv-service
```

## Observability

- **Traces**: http://localhost:16686 (Jaeger)
- **Metrics**: http://localhost:9090 (Prometheus)
- **Dashboards**: http://localhost:3000 (Grafana)
- **Logs**: http://localhost:3100 (Loki)

## Benchmarking

```bash
# Run k6 load test
k6 run benchmark/k6-load-test.js
```

## Project Structure

```
hono-csv-service/
├── src/
│   ├── handlers/          # REST + gRPC handlers
│   ├── middleware/        # Auth, rate-limit, security
│   ├── rpc/              # gRPC client
│   ├── telemetry/        # OTEL setup
│   ├── discovery/        # Consul client
│   ├── utils/            # CSV parser
│   ├── types.ts          # Zod schemas
│   └── index.ts          # HTTP + gRPC servers
├── proto/                # Protocol buffers
├── benchmark/            # k6 load tests
├── k8s-manifests/        # Kubernetes YAMLs
├── Dockerfile
├── package.json
└── tsconfig.json
```

## License

MIT
