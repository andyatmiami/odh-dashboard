#!/usr/bin/env bash
# Repeatedly run the full workspace unit-test target without Turbo caching.
# Trace files and run summaries are grouped by workspace attempt for later review.

set -uo pipefail

usage() {
  cat <<'EOF'
Usage: reproduce-feature-store-timing.sh [runs] [--continue-on-failure]

Runs the uncached workspace unit-test target repeatedly while collecting timing traces.

Arguments:
  runs                                      Number of attempts to run (default: 100)
  --continue-on-failure                     Run all runnable Turbo test tasks within each attempt,
                                             then complete all requested attempts. The script returns
                                             non-zero after the final attempt if any workspace failure
                                             was observed.
  -h, --help                                Show this help text.

By default, Turbo stops scheduling tasks after a failure, and the script stops
at the first Feature Store failure.
Results are written to <log-dir>/metadata/runs.tsv and to one JSON file per run.
EOF
}

max_runs=100
continue_on_failure=false
run_count_set=false

for argument in "$@"; do
  case "$argument" in
    --continue-on-failure)
      continue_on_failure=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ "$run_count_set" = true ]; then
        echo "Unexpected argument: $argument" >&2
        usage >&2
        exit 2
      fi
      max_runs="$argument"
      run_count_set=true
      ;;
  esac
done

if ! [[ "$max_runs" =~ ^[1-9][0-9]*$ ]]; then
  echo "Run count must be a positive integer: $max_runs" >&2
  exit 2
fi

timestamp="$(date +%Y%m%d-%H%M%S)"
log_dir="${FEATURE_STORE_TIMING_LOG_DIR:-${TMPDIR:-/tmp}/feature-store-timing-logs-${timestamp}}"
trace_dir="${log_dir}/traces"
metadata_dir="${log_dir}/metadata"
failure_dir="${log_dir}/failures"
feature_store_failure_count=0
workspace_failure_count=0

mkdir -p "$trace_dir" "$metadata_dir" "$failure_dir"

metadata_index="${metadata_dir}/runs.tsv"
printf 'run\tstarted_at\tcompleted_at\tstatus\texit_code\tfeature_store_failed\tturbo_continue_on_failure\tfailure_count\tlog\ttraces\tfailures\n' \
  > "$metadata_index"

print_banner() {
  local title="$1"

  printf '\n%s\n' '================================================================================'
  printf ' %s\n' "$title"
  printf '%s\n\n' '================================================================================'
}

print_banner 'Feature Store timing reproduction'
printf 'Attempts: %s\n' "$max_runs"
printf 'Continue after failures: %s\n' "$continue_on_failure"
printf 'Logs: %s\n' "$log_dir"
printf 'Run metadata: %s\n' "$metadata_index"

for iteration in $(seq 1 "$max_runs"); do
  log_file="${log_dir}/run-${iteration}.log"
  run_trace_dir="${trace_dir}/run-${iteration}"
  summary_file="${metadata_dir}/run-${iteration}.json"
  failures_file="${failure_dir}/run-${iteration}.txt"
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  mkdir -p "$run_trace_dir"

  print_banner "Run ${iteration}/${max_runs} started at ${started_at}"
  turbo_continue_args=()
  if [ "$continue_on_failure" = true ]; then
    turbo_continue_args+=(--continue=always)
  fi
  FEATURE_STORE_TIMING_TRACE_DIR="$run_trace_dir" pnpm run test-unit --force "${turbo_continue_args[@]}" 2>&1 | tee "$log_file"
  test_status="${PIPESTATUS[0]}"
  completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  rg ': FAIL ' "$log_file" > "$failures_file" || true
  failure_count="$(wc -l < "$failures_file" | tr -d ' ')"
  feature_store_failed=false
  if rg -q '@odh-dashboard/feature-store:test-unit: FAIL ' "$log_file"; then
    feature_store_failed=true
    feature_store_failure_count=$((feature_store_failure_count + 1))
  fi

  if [ "$test_status" -eq 0 ]; then
    run_status=passed
  else
    run_status=failed
  fi

  cat > "$summary_file" <<EOF
{
  "run": ${iteration},
  "startedAt": "${started_at}",
  "completedAt": "${completed_at}",
  "status": "${run_status}",
  "exitCode": ${test_status},
  "featureStoreFailed": ${feature_store_failed},
  "turboContinueOnFailure": ${continue_on_failure},
  "failureCount": ${failure_count},
  "logFile": "${log_file}",
  "traceDirectory": "${run_trace_dir}",
  "failureFile": "${failures_file}"
}
EOF
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$iteration" "$started_at" "$completed_at" "$run_status" "$test_status" \
    "$feature_store_failed" "$continue_on_failure" "$failure_count" "$log_file" "$run_trace_dir" "$failures_file" \
    >> "$metadata_index"

  print_banner "Run ${iteration}/${max_runs} ${run_status}"
  printf 'Exit code: %s\n' "$test_status"
  printf 'Feature Store failure: %s\n' "$feature_store_failed"
  printf 'Reported failures: %s (%s)\n' "$failure_count" "$failures_file"
  if [ "$failure_count" -gt 0 ]; then
    printf 'Failed suites:\n'
    sed 's/^/  - /' "$failures_file"
  fi
  printf 'Workspace log: %s\n' "$log_file"
  printf 'Failure traces: %s\n' "$run_trace_dir"
  printf 'Run summary: %s\n' "$summary_file"

  if [ "$feature_store_failed" = true ] && [ "$continue_on_failure" = false ]; then
    print_banner "Stopping after Feature Store failure on run ${iteration}"
    exit "$test_status"
  fi

  if [ "$test_status" -ne 0 ]; then
    workspace_failure_count=$((workspace_failure_count + 1))
  fi
done

print_banner "Feature Store timing reproduction complete"
printf 'Feature Store failures: %s\n' "$feature_store_failure_count"
printf 'Workspace runs with a non-zero exit: %s\n' "$workspace_failure_count"
printf 'Run metadata: %s\n' "$metadata_index"

if [ "$continue_on_failure" = true ] && [ "$workspace_failure_count" -ne 0 ]; then
  exit 1
fi

if [ "$feature_store_failure_count" -ne 0 ]; then
  exit 1
fi
