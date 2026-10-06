# Async Error-Test Timing

## Problem

`useFeatureStoreEntityByName` tests previously treated the next render after a
hook mount or parameter change as proof that the expected error state had been
published. Under a full workspace test run, the test for a missing entity name
occasionally observed `error: undefined` instead of `Entity name is required`.

The hook rejects the request correctly. The deficiency was in the test's
synchronization condition, not in the Feature Store API behavior.

## Why the Test Was Timing-Sensitive

The hook uses `useFetch` with `initialPromisePurity: true`.

1. `useFetch` starts from a reset state with no error.
2. Its effect invokes the callback, which rejects when an input is missing.
3. The rejection publishes the error in a later state update.

`waitForNextUpdate()` waits for a wrapper-local render count to increase; it
does not wait for the observable `result.current` value that the test asserts.
Extra worker and CPU contention during a workspace run makes the resulting
scheduling window easier to encounter.

## Confirmed Diagnostic Evidence

A full-workspace run reproduced the API-rejection case in
`useFeatureStoreEntityByName`. The trace captured both signals at the instant
`waitForNextUpdate()` resolved:

| Signal | Observed state |
| --- | --- |
| Wrapper render history | Initial state, then `Error("Failed to fetch entity")` |
| RTL `result.current` | Initial state: `loaded: false`, no error |

This confirms the test-level root cause. The wrapper counter can advance after
hook render work has produced the expected error while RTL has not yet exposed
that value through its committed `result.current`. The assertion therefore
correctly sees `undefined` even though `waitForNextUpdate()` has resolved.

### Why RTL `result.current` lags

The repository helper in `packages/jest-config/src/hooks.ts` increments
`updateCount` inside the callback passed to RTL's `renderHook`. That callback
runs during render. The installed RTL implementation (v16.3.2) then assigns
its returned `pendingResult` to `result.current` only in a passive
`React.useEffect`, which runs after render and commit.

The failing sequence is therefore:

1. `useFetch` catches the rejected request and schedules its error state.
2. React renders the hook with that error; the repository wrapper increments
   `updateCount` and records the error.
3. `waitForNextUpdate()` observes the counter increase and resolves.
4. RTL's passive effect has not yet assigned that render's value to
   `result.current`, so the test still observes the initial state.

The exact event-loop ordering determines how often this window appears, but
the structural cause is verified: the helper waits for render-phase work,
whereas the test reads a post-commit RTL ref. A render-count predicate is not
a state-publication guarantee.

## Audit Insight and Remediation Scope

`initialPromisePurity` exposed this failure, but it is not the criterion for a
robust test. The underlying deficiency is using an unspecified render as the
synchronization condition when the behavior under test is a terminal error
state.

A broad text search initially found 31 files. A call-site review refined that
to 27 test files and 59 waits where an error-path test calls
`waitForNextUpdate()` and then verifies an error. Eleven of the files directly
use the `initialPromisePurity` reset behavior, including the nine Feature Store
hook test files. The remaining files use other asynchronous hook
implementations.

Their current scheduling may differ, but they should use the same terminal-state
wait. An intermediate render can be introduced by an implementation change,
React scheduling, or an additional state update; a test should not rely on its
absence.

### Affected test files and call sites

The following inventory records the line containing the problematic
`waitForNextUpdate()` call. Update only these error-path waits; successful
fetch-path waits are outside this remediation.

| Test file | Call-site lines |
| --- | --- |
| `frontend/src/api/prometheus/__tests__/usePrometheusQuery.spec.ts` | 57 |
| `frontend/src/concepts/analyticsTracking/__tests__/useWatchSegmentKey.spec.ts` | 48 |
| `frontend/src/concepts/userConfigs/__tests__/useWatchGroups.spec.tsx` | 84 |
| `frontend/src/pages/modelServing/__tests__/useInferenceServices.spec.ts` | 266 |
| `frontend/src/pages/projects/screens/detail/storage/__tests__/useProjectPvcs.spec.ts` | 68 |
| `frontend/src/pages/projects/screens/spawner/environmentVariables/__tests__/useExistingSecrets.spec.ts` | 237 |
| `frontend/src/utilities/__tests__/useClusterQueue.spec.ts` | 96 |
| `frontend/src/utilities/__tests__/useRedirect.spec.ts` | 108, 126, 142 |
| `frontend/src/utilities/__tests__/useWatchIntegrationComponents.spec.ts` | 88 |
| `packages/automl/frontend/src/app/hooks/__tests__/usePipelineRuns.spec.ts` | 94 |
| `packages/autorag/frontend/src/app/hooks/__tests__/usePipelineDefinitions.spec.ts` | 53 |
| `packages/autorag/frontend/src/app/hooks/__tests__/usePipelineRuns.spec.ts` | 94 |
| `packages/eval-hub/frontend/src/app/hooks/__tests__/useEvaluationJobLogs.spec.ts` | 104, 117 |
| `packages/feature-store/src/apiHooks/__tests__/useConnectedWorkbenches.spec.ts` | 102 |
| `packages/feature-store/src/apiHooks/__tests__/useFeatureByName.spec.ts` | 81, 106, 131, 156, 188 |
| `packages/feature-store/src/apiHooks/__tests__/useFeatureServices.spec.ts` | 158, 182 |
| `packages/feature-store/src/apiHooks/__tests__/useFeatureStoreDataSourceByName.spec.ts` | 118, 142, 166, 190, 221, 368, 439, 463, 472, 492, 501 |
| `packages/feature-store/src/apiHooks/__tests__/useFeatureStoreDataSources.spec.ts` | 185, 209, 335 |
| `packages/feature-store/src/apiHooks/__tests__/useFeatureStoreEntities.spec.tsx` | 121, 145, 249 |
| `packages/feature-store/src/apiHooks/__tests__/useFeatureStoreEntityByName.spec.ts` | 90, 114, 138, 162, 296, 331, 340, 357, 366 |
| `packages/feature-store/src/apiHooks/__tests__/useFeatureViews.test.tsx` | 164, 188 |
| `packages/feature-store/src/apiHooks/__tests__/useFeatures.spec.ts` | 132 |
| `packages/model-serving/src/shared/hooks/__tests__/useServingRuntimeConfigList.spec.ts` | 74, 111, 131 |
| `packages/model-serving/src/shared/hooks/__tests__/useTemplateDisablement.spec.ts` | 50 |
| `packages/model-serving/src/shared/hooks/__tests__/useTemplateOrder.spec.ts` | 50 |
| `packages/nim-serving/src/api/accounts/__tests__/hooks.spec.ts` | 22 |
| `packages/ui-core/src/hooks/__tests__/useFetch.spec.ts` | 40 |

## Required Test Pattern

Wait for the observable terminal condition under test, not for a render count
or an unspecified next update:

```ts
await waitFor(() => {
  expect(renderResult.result.current.error).toEqual(
    new Error('Entity name is required'),
  );
});
```

After that wait, assert the stable contract: default data, `loaded: false`, and
no call to the API client for invalid inputs.

Avoid exact render-count assertions for effect-driven error paths. React effect
scheduling and batching are implementation details; the API contract is the
published fetch state.

## Render-Count Assertions

Do not remove render-count coverage indiscriminately. It is useful when the
number or timing of renders is itself the behavior under test, such as:

- a polling interval causing no update before it expires and one update when it
  does;
- a rerender producing only the expected state transition; or
- a hook remaining stable when inputs have not changed.

`packages/ui-core/src/hooks/__tests__/useFetch.spec.ts` has dedicated polling
and stability tests of this kind.

The 59 audited error waits are different. Their purpose is to verify the
published error state, not a specific implementation-level render sequence. Do
not use `hookToHaveUpdateCount(2)` to establish that the error arrived. Wait
for the expected error first, then retain only state and interaction assertions
that form the hook's observable contract.

If render efficiency matters for an error path, add a separate, purpose-named
test for that invariant. This keeps an extra intermediate render from making an
error-correctness test flaky while preserving intentional performance coverage.

## Scope

Apply this pattern to every error-path hook test identified by the audit, not
only Feature Store tests. This includes initial validation failures, rejected
requests, and failures after `rerender`.

Keep `waitForNextUpdate()` only where the test needs merely to observe a known
single asynchronous success transition and does not depend on an intermediate
state being absent. Do not use it as evidence that an expected error was
published.

## Addendum: Timer-Deadline Flakes

This is a separate failure pattern from the terminal-error synchronization
problem above. A full-workspace reproduction run exposed it in
`packages/eval-hub/frontend/src/__tests__/unit/testUtils/hooks.spec.ts`.

The test schedules a state update after 20 ms, then expects
`waitForNextUpdate({ timeout: 10 })` to time out. That outcome is not
guaranteed: JavaScript timers are minimum-delay scheduling requests, not
precise deadlines. The process can be delayed after the 20 ms timer is
registered but before the waiter begins; when it resumes, the state update may
already have occurred and the waiter correctly resolves.

Do not use two nearby real-time deadlines to prove ordering. For a test whose
purpose is timeout behavior, use a hook that cannot update (or a deferred
operation whose resolver remains under the test's control). Use fake timers
and explicit time advancement when timer behavior itself is the contract.

This Eval Hub failure is not evidence that `useFetch` lost or delayed an error
state. It can interrupt a workspace reproduction run, however, so classify it
separately from Feature Store failures and retain its log for follow-up.

## Addendum: Render Count Is Not a Committed Result

Workspace stress runs also found a related failure mode on a successful fetch.
`packages/gpuaas/src/hooks/__tests__/useKueueProjectsForClusterQueue.spec.ts`
waited for the next update and then expected loaded project data, but received
the initial empty data instead.

The diagnostic trace for that failure recorded two different observations at
the instant `waitForNextUpdate()` resolved:

| Observation | State |
| --- | --- |
| Wrapper render history | Initial `loaded: false`, then `loaded: true` |
| RTL `result.current` | `loaded: false` |

`waitForNextUpdate()` relies on a counter maintained inside a wrapper around
RTL's `renderHook`; it does not wait for the observable `result.current` value
that the test will assert. RTL writes that ref from a post-commit passive
effect, while the wrapper increments the counter during render. The trace
proves those signals can diverge during a stress run.

Eval Hub has a local copy of this helper. Its helper test also failed with
update count two while its hook value was still the initial empty string,
providing an independent symptom of the same test-utility weakness.

Extend the remediation review beyond error paths: whenever a test calls
`waitForNextUpdate()` and then asserts a terminal success value, wait for that
specific value with `waitFor` instead. Keep render-count assertions only in
separate tests whose explicit purpose is render behavior.

## External Support for State-Based Waiting

The repository evidence above is sufficient to require a test change. The
following primary sources explain why the state-based pattern is also the
supported Testing Library and React model:

- [Testing Library's `waitFor` documentation](https://testing-library.com/docs/dom-testing-library/api-async/#waitfor)
  defines completion as the supplied expectation no longer throwing. Use an
  expectation on `result.current`, rather than an incidental render count.
- [React Testing Library's `renderHook` documentation](https://testing-library.com/docs/react-testing-library/api/#renderhook-result)
  describes `result.current` as the most recently **committed** value. This is
  the observable value a hook test must synchronize with and assert.
- [React's React 18 release post](https://react.dev/blog/2022/03/29/react-v18#what-is-concurrent-react)
  explains that concurrent rendering is interruptible and that React may
  abandon in-progress rendering work before committing it. The local RTL source
  already explains this repository's observed lag through its passive-effect
  assignment; this source independently reinforces why a render callback is
  weaker evidence than an observable state value.
- The Testing Library hooks project's
  [`waitForNextUpdate` missed-updates issue](https://github.com/testing-library/react-hooks-testing-library/issues/656)
  records comparable flakes caused by updates and waiters resolving in
  different orders. A project maintainer advises treating intermediate hook
  values as implementation details. This is historical evidence from the
  predecessor package, not a claim that it is the direct cause of this
  repository's custom helper.

Together, these sources reinforce the local trace results: use
`waitForNextUpdate()` only when any subsequent update is genuinely an
acceptable completion condition. When correctness depends on a specific data,
loaded, or error value, wait for that value directly.

## Verification

Run the focused test:

```bash
pnpm --filter @odh-dashboard/feature-store exec jest \
  src/apiHooks/__tests__/useFeatureStoreEntityByName.spec.ts \
  --runInBand \
  --silent
```

Then run the affected package suites and the workspace suite:

```bash
pnpm --filter @odh-dashboard/feature-store run test-unit
pnpm run test-unit
```

For repeated uncached workspace runs with timing traces, use:

```bash
scripts/reproduce-feature-store-timing.sh 100
```

The script stops at the first Feature Store test failure by default. To run all
runnable workspace test tasks within every attempt and always complete the
requested number of attempts, use:

```bash
scripts/reproduce-feature-store-timing.sh 100 --continue-on-failure
```

Each run produces a log, trace directory, failure list, and JSON summary. The
`metadata/runs.tsv` file in the generated log directory provides one compact
row per attempt with its status, failure count, and Turbo continuation mode.
When a run has failures, its terminal summary also lists the failed suites as
indented bullets.
