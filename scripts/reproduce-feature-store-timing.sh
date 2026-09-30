#!/usr/bin/env bash
# Repeatedly run the full workspace unit-test target without Turbo caching.
# Trace files are grouped by workspace attempt so a failure can be inspected in isolation.

set -uo pipefail

max_runs="${1:-100}"
timestamp="$(date +%Y%m%d-%H%M%S)"
log_dir="${FEATURE_STORE_TIMING_LOG_DIR:-${TMPDIR:-/tmp}/feature-store-timing-logs-${timestamp}}"
trace_dir="${log_dir}/traces"
non_target_failure_count=0

mkdir -p "$trace_dir"

echo "Running up to ${max_runs} uncached workspace unit-test attempts."
echo "Logs: ${log_dir}"

for iteration in $(seq 1 "$max_runs"); do
  log_file="${log_dir}/run-${iteration}.log"
  run_trace_dir="${trace_dir}/run-${iteration}"

  mkdir -p "$run_trace_dir"

  echo "=== Workspace unit-test run ${iteration} ==="
  FEATURE_STORE_TIMING_TRACE_DIR="$run_trace_dir" pnpm run test-unit --force 2>&1 | tee "$log_file"
  test_status="${PIPESTATUS[0]}"

  if rg -q '@odh-dashboard/feature-store:test-unit: FAIL ' "$log_file"; then
    echo "Feature Store failure on run ${iteration}."
    echo "Workspace log: ${log_file}"
    echo "Failure traces: ${run_trace_dir}"
    exit "$test_status"
  fi

  if [ "$test_status" -ne 0 ]; then
    non_target_failure_count=$((non_target_failure_count + 1))
    echo "Non-Feature-Store workspace failure on run ${iteration}; continuing."
    echo "Workspace log: ${log_file}"
    echo "Run traces: ${run_trace_dir}"
  fi
done

echo "No Feature Store failures after ${max_runs} runs."
echo "Non-Feature-Store workspace failures logged: ${non_target_failure_count}"
