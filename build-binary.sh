#!/bin/bash
#
# Build standalone binaries for CSV microservices
# Compiles TypeScript to native executables using Bun
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_OS="${TARGET_OS:-linux}"
TARGET_ARCH="${TARGET_ARCH:-x64}"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${BLUE}[$(date +'%H:%M:%S')]${NC} $1"; }
log_success() { echo -e "${GREEN}[✓]${NC} $1"; }

# ============================================================================
# Build Functions
# ============================================================================

build_hono() {
    log "Building Hono CSV Service binary..."

    cd "$SCRIPT_DIR/hono-csv-service"

    bun install

    bun build src/index.ts \
        --compile \
        --outfile ./bin/csv-service-hono \
        --target "bun-${TARGET_OS}-${TARGET_ARCH}" \
        --minify

    chmod +x ./bin/csv-service-hono

    local size=$(du -h ./bin/csv-service-hono | cut -f1)
    log_success "Hono binary created: ./hono-csv-service/bin/csv-service-hono (${size})"
}

build_elysia() {
    log "Building Elysia CSV Service binary..."

    cd "$SCRIPT_DIR/elysia-csv-service"

    bun install

    bun build src/index.ts \
        --compile \
        --outfile ./bin/csv-service-elysia \
        --target "bun-${TARGET_OS}-${TARGET_ARCH}" \
        --minify

    chmod +x ./bin/csv-service-elysia

    local size=$(du -h ./bin/csv-service-elysia | cut -f1)
    log_success "Elysia binary created: ./elysia-csv-service/bin/csv-service-elysia (${size})"
}

build_all() {
    log "Building binaries for ${TARGET_OS}-${TARGET_ARCH}..."

    mkdir -p "$SCRIPT_DIR/hono-csv-service/bin"
    mkdir -p "$SCRIPT_DIR/elysia-csv-service/bin"

    build_hono
    build_elysia

    echo ""
    log_success "All binaries built successfully!"
    echo ""
    echo "Run services directly:"
    echo "  ./hono-csv-service/bin/csv-service-hono"
    echo "  ./elysia-csv-service/bin/csv-service-elysia"
}

# ============================================================================
# Parse Arguments
# ============================================================================

case "${1:-all}" in
    hono)
        build_hono
        ;;
    elysia)
        build_elysia
        ;;
    all|"")
        build_all
        ;;
    --help|-h)
        echo "Usage: $0 [hono|elysia|all]"
        echo ""
        echo "Environment variables:"
        echo "  TARGET_OS=linux|darwin|windows  (default: linux)"
        echo "  TARGET_ARCH=x64|aarch64|arm64  (default: x64)"
        echo ""
        echo "Examples:"
        echo "  $0                    # Build all for Linux x64"
        echo "  $0 hono               # Build Hono only"
        echo "  TARGET_OS=darwin $0   # Build for macOS"
        echo "  TARGET_OS=windows $0  # Build for Windows"
        exit 0
        ;;
    *)
        echo "Unknown target: $1"
        echo "Run '$0 --help' for usage"
        exit 1
        ;;
esac
