#!/bin/bash
#
# CSV Microservices Benchmark Script
# Compares Hono vs Elysia in both Binary and Minified modes
# Total: 4 container variants benchmarked
#
# Usage: ./run-benchmarks.sh [options]
#
# Options:
#   --binary-only      Benchmark only binary variants
#   --minified-only    Benchmark only minified runtime variants
#   --skip-otel        Skip OTEL stack (faster)
#   --skip-build       Skip building Docker images
#   --no-cleanup       Don't cleanup after benchmark
#   --parallel         Run all variants in parallel
#   --help             Show this help
#

set -e

# ============================================================================
# Configuration
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="csv-benchmark"
BUILD_MODE="${BUILD_MODE:-all}"  # all, binary, minified
PARALLEL="${PARALLEL:-false}"

# Service endpoints
HONO_BINARY_URL="http://localhost:3000"
HONO_MINIFIED_URL="http://localhost:3010"
ELYSIA_BINARY_URL="http://localhost:3001"
ELYSIA_MINIFIED_URL="http://localhost:3011"

# Observability
JAEGER_URL="http://localhost:16686"
PROMETHEUS_URL="http://localhost:9090"
GRAFANA_URL="http://localhost:3002"

# Benchmark settings
VUS="${VUS:-500}"
TEST_DURATION="${TEST_DURATION:-2m}"
STAGING_DURATION="${STAGING_DURATION:-30s}"
CSV_SIZE="${CSV_SIZE:-100000}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m'

# Options
SKIP_OTEL=false
SKIP_BUILD=false
NO_CLEANUP=false
GENERATE_CSV=false
BINARY_ONLY=false
MINIFIED_ONLY=false

log() { echo -e "${BLUE}[$(date +'%H:%M:%S')]${NC} $1"; }
log_success() { echo -e "${GREEN}[✓]${NC} $1"; }
log_error() { echo -e "${RED}[✗]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[!]${NC} $1"; }
log_section() {
    echo -e "\n${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${MAGENTA}  $1${NC}"
    echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
}

print_banner() {
    echo -e "${CYAN}"
    cat << "EOF"
 ____                               __  ____
|  _ \ _ __ ___  _ __   (_)_ __ │ |_
| |_) | '__/ _ \| ' *   / | '_ \_ | _ |
|  _ <| | | (_) | | |__| |_) | | | |
|_| \_\_|  \___/|_|_____|\___/|_|_|_|
     _           _     _       _         _
    / \   _ __  | |   (_)_ __ | |_ __ _|
   / _ \ | '_ \ | |   | | '_ \| __/ _` | |
  / ___ \| |_) || |___| | | | | || (_| |
 /_/   \_\ .__/_____||_|_||_| \__,_|_|
     |_|
EOF
    echo -e "${NC}    ${CYAN}Framework & Build Mode Comparison${NC}\n"
}

# ============================================================================
# Parse Arguments
# ============================================================================

parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --binary-only)
                BINARY_ONLY=true
                BUILD_MODE="binary"
                shift
                ;;
            --minified-only)
                MINIFIED_ONLY=true
                BUILD_MODE="minified"
                shift
                ;;
            --skip-otel)
                SKIP_OTEL=true
                shift
                ;;
            --skip-build)
                SKIP_BUILD=true
                shift
                ;;
            --no-cleanup)
                NO_CLEANUP=true
                shift
                ;;
            --generate-csv)
                GENERATE_CSV=true
                shift
                ;;
            --parallel)
                PARALLEL=true
                shift
                ;;
            --vus)
                VUS="$2"
                shift 2
                ;;
            --duration)
                TEST_DURATION="$2"
                shift 2
                ;;
            --help|-h)
                show_help
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                echo "Use --help for usage information"
                exit 1
                ;;
        esac
    done

    if [ "$BINARY_ONLY" = true ] && [ "$MINIFIED_ONLY" = true ]; then
        log_error "Cannot specify both --binary-only and --minified-only"
        exit 1
    fi

    if [ "$BINARY_ONLY" = true ]; then
        BUILD_MODE="binary"
    elif [ "$MINIFIED_ONLY" = true ]; then
        BUILD_MODE="minified"
    fi
}

show_help() {
    print_banner
    cat << EOF
Usage: $0 [OPTIONS]

Build Modes (compares all variants by default):
  --binary-only      Benchmark only binary variants (2 containers)
  --minified-only    Benchmark only minified runtime variants (2 containers)
  (default)          Benchmark all 4 variants (binary + minified for both)

Options:
  --skip-otel        Skip OTEL stack (faster, no observability)
  --skip-build       Skip Docker image build
  --no-cleanup       Don't cleanup containers after benchmark
  --parallel         Run all variants in parallel
  --generate-csv     Export results to CSV
  --vus NUM          Number of virtual users (default: 500)
  --duration DUR      Test duration (default: 2m)
  --help             Show this help message

Environment Variables:
  VUS               Virtual users count
  TEST_DURATION     How long the test runs
  BUILD_TYPE        Override build mode (all/binary/minified)

Examples:
  # Benchmark all 4 variants
  $0

  # Binary only (faster)
  $0 --binary-only

  # Compare binary vs minified
  $0 && docker-compose -f docker-compose.minified.yml benchmark

  # Parallel execution (fastest, needs more ports)
  $0 --parallel

Variants Benchmarked:
   1. Hono Binary        → http://localhost:3000
  2. Hono Minified      → http://localhost:3010
  3. Elysia Binary      → http://localhost:3001
   4. Elysia Minified    → http://localhost:3011

Observability (after startup):
  - Jaeger (Traces):  ${JAEGER_URL}
  - Prometheus:       ${PROMETHEUS_URL}
  - Grafana:          ${GRAFANA_URL}
EOF
}

# ============================================================================
# Utility Functions
# ============================================================================

check_dependencies() {
    log_section "Checking Dependencies"

    local missing_deps=()

    command -v docker >/dev/null 2>&1 || missing_deps+=("docker")
    command -v docker-compose >/dev/null 2>&1 || missing_deps+=("docker-compose")
    command -v k6 >/dev/null 2>&1 || missing_deps+=("k6")

    if [ ${#missing_deps[@]} -gt 0 ]; then
        log_error "Missing dependencies: ${missing_deps[*]}"
        echo ""
        echo "Install missing tools:"
        echo "  docker:     https://docs.docker.com/get-docker/"
        echo "  k6:         brew install k6  # or https://k6.io"
        exit 1
    fi

    log_success "All dependencies available"
}

build_images() {
    if [ "$SKIP_BUILD" = true ]; then
        log_warn "Skipping Docker image build"
        return
    fi

    log_section "Building Docker Images"

    cd "$SCRIPT_DIR"

    local targets=()

    if [ "$BUILD_MODE" = "all" ] || [ "$BUILD_MODE" = "binary" ]; then
        log "Building Hono Binary..."
        docker build --target binary-production -t hono-csv-service:binary ./hono-csv-service
        targets+=("hono-csv-service:binary")
    fi

    if [ "$BUILD_MODE" = "all" ] || [ "$BUILD_MODE" = "minified" ]; then
        log "Building Hono Minified..."
        docker build --target runtime -t hono-csv-service:minified ./hono-csv-service
        targets+=("hono-csv-service:minified")
    fi

    if [ "$BUILD_MODE" = "all" ] || [ "$BUILD_MODE" = "binary" ]; then
        log "Building Elysia Binary..."
        docker build --target binary-production -t elysia-csv-service:binary ./elysia-csv-service
        targets+=("elysia-csv-service:binary")
    fi

    if [ "$BUILD_MODE" = "all" ] || [ "$BUILD_MODE" = "minified" ]; then
        log "Building Elysia Minified..."
        docker build --target runtime -t elysia-csv-service:minified ./elysia-csv-service
        targets+=("elysia-csv-service:minified")
    fi

    log_success "Built ${#targets[@]} images: ${targets[*]}"
}

# ============================================================================
# Service Management
# ============================================================================

start_services() {
    log_section "Starting Services"

    cd "$SCRIPT_DIR"

    # Clean up any previous runs
    docker-compose -f docker-compose.otel.yml --project-name "$PROJECT_NAME" down -v 2>/dev/null || true

    # Start binary services
    if [ "$BUILD_MODE" = "all" ] || [ "$BUILD_MODE" = "binary" ]; then
        log "Starting Binary Services..."
        docker-compose -f docker-compose.otel.yml --project-name "$PROJECT_NAME-binary" up -d hono-csv-service elysia-csv-service
    fi

    # Start minified services
    if [ "$BUILD_MODE" = "all" ] || [ "$BUILD_MODE" = "minified" ]; then
        log "Starting Minified Runtime Services..."
        docker-compose -f docker-compose.minified.yml --project-name "$PROJECT_NAME-minified" up -d hono-csv-service elysia-csv-service
    fi

    log_success "Services started"
    echo ""
}

wait_for_services() {
    log_section "Waiting for Services to Be Ready"

    local services_to_check=()
    local service_urls=()
    local service_names=()

    if [ "$BUILD_MODE" = "all" ] || [ "$BUILD_MODE" = "binary" ]; then
        services_to_check+=("Hono Binary")
        service_urls+=("$HONO_BINARY_URL")
        service_names+=("csv-service-hono-binary")

        services_to_check+=("Elysia Binary")
        service_urls+=("$ELYSIA_BINARY_URL")
        service_names+=("csv-service-elysia-binary")
    fi

    if [ "$BUILD_MODE" = "all" ] || [ "$BUILD_MODE" = "minified" ]; then
        services_to_check+=("Hono Minified")
        service_urls+=("$HONO_MINIFIED_URL")
        service_names+=("csv-service-hono-minified")

        services_to_check+=("Elysia Minified")
        service_urls+=("$ELYSIA_MINIFIED_URL")
        service_names+=("csv-service-elysia-minified")
    fi

    local max_wait=90
    local all_ready=true

    for i in "${!service_urls[@]}"; do
        local name="${services_to_check[$i]}"
        local url="${service_urls[$i]}"

        if wait_for_single_service "$name" "$url" $max_wait; then
            log_success "$name is ready!"
        else
            log_error "$name failed to start"
            all_ready=false
        fi
    done

    if [ "$all_ready" = false ]; then
        log_error "Some services failed to start"
        exit 1
    fi

    echo ""
}

wait_for_single_service() {
    local service_name="$1"
    local service_url="$2"
    local max_wait="${3:-60}"
    local wait_time=0

    log -n "Waiting for $service_name..."

    while [ $wait_time -lt $max_wait ]; do
        if curl -sSf "$service_url/health" >/dev/null 2>&1; then
            echo ""
            return 0
        fi
        echo -n "."
        sleep 2
        wait_time=$((wait_time + 2))
    done

    echo ""
    return 1
}

show_service_info() {
    log_section "Service Information"

    echo -e "${CYAN}Active Variants:${NC}"

    if [ "$BUILD_MODE" = "all" ] || [ "$BUILD_MODE" = "binary" ]; then
        echo -e "  Hono Binary:       ${GREEN}${HONO_BINARY_URL}${NC}  (build: binary)"
        echo -e "  Elysia Binary:     ${GREEN}${ELYSIA_BINARY_URL}${NC}  (build: binary)"
    fi

    if [ "$BUILD_MODE" = "all" ] || [ "$BUILD_MODE" = "minified" ]; then
        echo -e "  Hono Minified:     ${YELLOW}${HONO_MINIFIED_URL}${NC}  (build: runtime)"
        echo -e "  Elysia Minified:   ${YELLOW}${ELYSIA_MINIFIED_URL}${NC}  (build: runtime)"
    fi

    echo ""
    echo -e "${CYAN}Observability:${NC}"
    echo -e "  Jaeger:     ${JAEGER_URL}"
    echo -e "  Prometheus:  ${PROMETHEUS_URL}"
    echo -e "  Grafana:    ${GRAFANA_URL}"
    echo ""
}

# ============================================================================
# Benchmarking
# ============================================================================

run_benchmarks() {
    log_section "Running Benchmarks"

    local results_dir="${SCRIPT_DIR}/benchmark/results"
    mkdir -p "$results_dir"

    local timestamp=$(date +"%Y%m%d_%H%M%S")

    # Build k6 config with all variants
    local k6_config="/tmp/k6-config-${timestamp}.js"
    build_k6_config "$k6_config"

    # Run k6 with the generated config
    log "Starting k6 load test..."
    cd "$SCRIPT_DIR"

    local json_output="${results_dir}/k6-results-${timestamp}.json"
    local html_output="${results_dir}/k6-report-${timestamp}.html"

    k6 run \
        --out json="$json_output" \
        --summary-export="$html_output" \
        "$k6_config" 2>&1 | tee /dev/tty

    log_success "Benchmark complete!"
    log "Results saved to:"
    log "  $json_output"
    log "  $html_output"

    # Generate comparison
    generate_comparison_report "$json_output"

    echo ""
}

build_k6_config() {
    local output_file="$1"

    cat > "$output_file" << 'K6_CONFIG'
import http from 'k6';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// Metrics
const errorRate = new Rate('errors');
const p95Latency = new Trend('p95_latency');
const processingRate = new Counter('rows_processed');
const fileUploadSize = new Trend('file_upload_size');

// Configuration
const HONO_BINARY_URL = __ENV.HONO_BINARY_URL || 'http://localhost:3000';
const HONO_MINIFIED_URL = __ENV.HONO_MINIFIED_URL || 'http://localhost:3010';
const ELYSIA_BINARY_URL = __ENV.ELYSIA_BINARY_URL || 'http://localhost:3001';
const ELYSIA_MINIFIED_URL = __ENV.ELYSIA_MINIFIED_URL || 'http://localhost:3011';

const VUS = parseInt(__ENV.VUS || '500');
const TEST_DURATION = __ENV.TEST_DURATION || '2m';
const STAGING_DURATION = __ENV.STAGING_DURATION || '30s';

export const options = {
  scenarios: {
    hono_binary_load: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeLimit: TEST_DURATION,
      preAllocatedVUs: VUS,
      stages: [
        { duration: '30s', target: Math.floor(VUS * 0.2) },
        { duration: '1m', target: Math.floor(VUS * 0.5) },
        { duration: '30s', target: VUS },
        { duration: '1m', target: VUS },
        { duration: '30s', target: Math.floor(VUS * 0.2) },
        { duration: '30s', target: 0 },
      ],
      exec: 'honoBinaryTest',
      startTime: '0s',
      tags: { mode: 'binary', framework: 'hono' },
    },

    hono_minified_load: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeLimit: TEST_DURATION,
      preAllocatedVUs: VUS,
      stages: [
        { duration: '30s', target: Math.floor(VUS * 0.2) },
        { duration: '1m', target: Math.floor(VUS * 0.5) },
        { duration: '30s', target: VUS },
        { duration: '1m', target: VUS },
        { duration: '30s', target: Math.floor(VUS * 0.2) },
        { duration: '30s', target: 0 },
      ],
      exec: 'honoMinifiedTest',
      startTime: '0s',
      tags: { mode: 'minified', framework: 'hono' },
    },

    elysia_binary_load: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeLimit: TEST_DURATION,
      preAllocatedVUs: VUS,
      stages: [
        { duration: '30s', target: Math.floor(VUS * 0.2) },
        { duration: '1m', target: Math.floor(VUS * 0.5) },
        { duration: '30s', target: VUS },
        { duration: '1m', target: VUS },
        { duration: '30s', target: Math.floor(VUS * 0.2) },
        { duration: '30s', target: 0 },
      ],
      exec: 'elysiaBinaryTest',
      startTime: '0s',
      tags: { mode: 'binary', framework: 'elysia' },
    },

    elysia_minified_load: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeLimit: TEST_DURATION,
      preAllocatedVUs: VUS,
      stages: [
        { duration: '30s', target: Math.floor(VUS * 0.2) },
        { duration: '1m', target: Math.floor(VUS * 0.5) },
        { duration: '30s', target: VUS },
        { duration: '1m', target: VUS },
        { duration: '30s', target: Math.floor(VUS * 0.2) },
        { duration: '30s', target: 0 },
      ],
      exec: 'elysiaMinifiedTest',
      startTime: '0s',
      tags: { mode: 'minified', framework: 'elysia' },
    },

    health_stress: {
      executor: 'constant-arrival-rate',
      rate: 1000,
      timeLimit: '1m',
      preAllocatedVUs: 50,
      exec: 'healthStressTest',
      startTime: '0s',
      tags: { test: 'health' },
    },
  },

  thresholds: {
    'http_req_duration': ['p(95)<2000', 'p(99)<5000'],
    'http_req_failed': ['rate<0.01'],
    'errors': ['rate<0.01'],
  },
};

// ============================================================================
// Test Functions
// ============================================================================

function uploadCSV(baseUrl, authHeaders, rowCount) {
  const regions = ['North_America', 'Europe', 'Asia_Pacific', 'Latin_America', 'Middle_East'];
  const countries = ['USA', 'Canada', 'UK', 'Germany', 'France', 'Japan', 'China', 'Brazil', 'Mexico', 'UAE'];
  const categories = ['Electronics', 'Clothing', 'Food', 'Books', 'Toys'];

  let csv = 'id,region,country,amount,date,category\n';

  for (let i = 1; i <= rowCount; i++) {
    const region = regions[Math.floor(Math.random() * regions.length)];
    const country = countries[Math.floor(Math.random() * countries.length)];
    const amount = (Math.random() * 1000 + 10).toFixed(2);
    const date = new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const category = categories[Math.floor(Math.random() * categories.length)];

    csv += `${i},${region},${country},${amount},${date},${category}\n`;
  }

  const boundary = '----WebKitFormBoundary' + Math.random().toString(16).substring(2);
  let body = '';

  body += `--${boundary}\r\n`;
  body += 'Content-Disposition: form-data; name="file"; filename="test.csv"\r\n';
  body += 'Content-Type: text/csv\r\n\r\n';
  body += csv + '\r\n';
  body += `--${boundary}--\r\n`;

  return { boundary, body };
}

export function honoBinaryTest() {
  const { boundary, body } = uploadCSV(HONO_BINARY_URL, null, 1000);

  const params = {
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    timeout: '30s',
  };

  const res = http.post(`${HONO_BINARY_URL}/api/v1/import`, body, params);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has data': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.success === true;
      } catch {
        return false;
      }
    },
  });

  errorRate.add(!check(res, {
    'status is 200': (r) => r.status === 200,
  }));

  sleep(Math.random() * 2);
}

export function honoMinifiedTest() {
  const { boundary, body } = uploadCSV(HONO_MINIFIED_URL, null, 1000);

  const params = {
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    timeout: '30s',
  };

  const res = http.post(`${HONO_MINIFIED_URL}/api/v1/import`, body, params);

  check(res, {
    'status is 200': (r) => r.status === 200,
  });

  errorRate.add(!check(res, {
    'status is 200': (r) => r.status === 200,
  }));

  sleep(Math.random() * 2);
}

export function elysiaBinaryTest() {
  const { boundary, body } = uploadCSV(ELYSIA_BINARY_URL, null, 1000);

  const params = {
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    timeout: '30s',
  };

  const res = http.post(`${ELYSIA_BINARY_URL}/api/v1/import`, body, params);

  check(res, {
    'status is 200': (r) => r.status === 200,
  });

  errorRate.add(!check(res, {
    'status is 200': (r) => r.status === 200,
  }));

  sleep(Math.random() * 2);
}

export function elysiaMinifiedTest() {
  const { boundary, body } = uploadCSV(ELYSIA_MINIFIED_URL, null, 1000);

  const params = {
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    timeout: '30s',
  };

  const res = http.post(`${ELYSIA_MINIFIED_URL}/api/v1/import`, body, params);

  check(res, {
    'status is 200': (r) => r.status === 200,
  });

  errorRate.add(!check(res, {
    'status is 200': (r) => r.status === 200,
  }));

  sleep(Math.random() * 2);
}

export function healthStressTest() {
  const urls = [
    HONO_BINARY_URL,
    HONO_MINIFIED_URL,
    ELYSIA_BINARY_URL,
    ELYSIA_MINIFIED_URL,
  ];

  for (const url of urls) {
    const res = http.get(`${url}/health`, { tags: { url: url } });
    check(res, {
      'status 200 or 503': (r) => r.status === 200 || r.status === 503,
    });
  }
}
K6_CONFIG
}

generate_comparison_report() {
    local json_file="$1"

    if [ ! -f "$json_file" ]; then
        return
    fi

    log_section "Generating Comparison Report"

    local results_dir="${SCRIPT_DIR}/benchmark/results"
    local report_file="${results_dir}/comparison-$(date +"%Y%m%d_%H%M%S").txt"

    echo "Generating comprehensive comparison report..."

    # Parse with jq if available
    if command -v jq >/dev/null 2>&1; then
        local framework="Hono"
        local build_type="binary"

        # Extract metrics (simplified)
        local total_reqs=$(jq -r '.metrics.http_reqs?.values.count // 0' "$json_file" 2>/dev/null || echo "0")
        local p95=$(jq -r '.metrics.http_req_duration?.values["p(95)"] // "N/A"' "$json_file" 2>/dev/null || echo "N/A")
        local p99=$(jq -r '.metrics.http_req_duration?.values["p(99)"] // "N/A"' "$json_file" 2>/dev/null || echo "N/A")
        local error_rate=$(jq -r '(.metrics.http_req_failed?.values.rate // 0) * 100 | floor' "$json_file" 2>/dev/null || echo "0")

        cat > "$report_file" << EOF
================================================================================
                    CSV MICROSERVICES BENCHMARK REPORT
================================================================================

Generated: $(date)
Build Mode: $BUILD_MODE
Test Configuration:
  - Virtual Users:  ${VUS}
  - Duration:        ${TEST_DURATION}
  - CSV Size:        ${CSV_SIZE} rows

--------------------------------------------------------------------------------
Variant Comparison Summary
--------------------------------------------------------------------------------

Framework  | Build Type    | P95 Latency | P99 Latency | Error Rate
-----------|---------------|-------------|-------------|------------
Hono       | Binary        | ${p95}ms     | ${p99}ms     | ${error_rate}%
Hono       | Minified      | N/A         | N/A         | N/A
Elysia     | Binary        | N/A         | N/A         | N/A
Elysia     | Minified      | N/A         | N/A         | N/A

--------------------------------------------------------------------------------
Performance Targets
--------------------------------------------------------------------------------

Target Metrics:
  - P95 Latency:  < 2000ms
  - P99 Latency:  < 5000ms
  - Success Rate: > 99%
  - Memory:       < 500Mi

--------------------------------------------------------------------------------
Build Type Comparison
--------------------------------------------------------------------------------

Binary:
  - Size: ~30MB per image
  - Cold Start: ~50ms
  - Contains: Embedded Bun runtime
  - Best for: Benchmarking, Edge, Serverless

Minified Runtime:
  - Size: ~80MB per image
  - Cold Start: ~200ms
  - Contains: Minified code + separate Bun runtime
  - Best for: Traditional production, Debugging

EOF

        cat "$report_file"
        log_success "Report saved to: $report_file"
    else
        log_warn "jq not found, skipping detailed report"
    fi
}

# ============================================================================
# Cleanup
# ============================================================================

cleanup() {
    if [ "$NO_CLEANUP" = true ]; then
        log_warn "Skipping cleanup (--no-cleanup flag set)"
        log "Services are still running. Stop them with:"
        log "  docker-compose -f docker-compose.otel.yml down"
        log "  docker-compose -f docker-compose.minified.yml down"
        return
    fi

    log_section "Cleaning Up"

    cd "$SCRIPT_DIR"

    docker-compose -f docker-compose.otel.yml --project-name "$PROJECT_NAME-binary" down -v 2>/dev/null || true
    docker-compose -f docker-compose.minified.yml --project-name "$PROJECT_NAME-minified" down -v 2>/dev/null || true

    log_success "Cleanup complete"
}

cleanup_on_error() {
    log_error "Cleanup on error..."
    cleanup
    exit 1
}

trap cleanup_on_error ERR INT TERM

# ============================================================================
# Main Execution
# ============================================================================

main() {
    print_banner
    parse_args "$@"

    # Clean up any previous runs
    log "Cleaning up any previous test runs..."
    cd "$SCRIPT_DIR"
    docker-compose -f docker-compose.otel.yml --project-name "$PROJECT_NAME-binary" down -v 2>/dev/null || true
    docker-compose -f docker-compose.minified.yml --project-name "$PROJECT_NAME-minified" down -v 2>/dev/null || true

    check_dependencies
    build_images
    start_services
    wait_for_services
    show_service_info

    # Pause before running benchmark
    log "Waiting 5 seconds for services to stabilize..."
    sleep 5

    run_benchmarks

    # Final summary
    log_section "Benchmark Complete"

    echo ""
    log_success "All benchmarks finished!"

    if [ "$NO_CLEANUP" = false ]; then
        log "Cleaning up in 10 seconds (Ctrl+C to cancel)..."
        sleep 10
        cleanup
    else
        echo ""
        log_warn "Services are still running for manual inspection"
    fi

    echo ""
    log_success "Done! Check benchmark/results/ for detailed reports."
}

# Run main
main "$@"
