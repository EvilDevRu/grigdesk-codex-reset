#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${GRIGDESK_SOURCE_ROOT:?Set GRIGDESK_SOURCE_ROOT to a compatible GrigDesk checkout}"
export NODE_TEST_MAX_RSS_MB=4096

cd "$GRIGDESK_SOURCE_ROOT"
exec bash tests/run-node-tests-safe.sh --test --test-concurrency=2 "$PLUGIN_ROOT"/tests/*.test.mjs
