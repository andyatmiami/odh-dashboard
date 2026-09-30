import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderHook as renderHookRTL, RenderHookOptions, waitFor } from '@testing-library/react';
import { queries, Queries } from '@testing-library/dom';
import type { BooleanValues, RenderHookResultExt } from '../types';

type TimingTraceState = {
  type: string;
  loaded?: boolean;
  error?: {
    name: string;
    message: string;
  };
};

const timingTraceEnabled = Boolean(process.env.FEATURE_STORE_TIMING_TRACE_DIR);

const isTimingTraceResult = (result: unknown): result is { loaded?: unknown; error?: unknown } =>
  typeof result === 'object' && result !== null;

const getTimingTraceState = (result: unknown): TimingTraceState => {
  if (!isTimingTraceResult(result)) {
    return { type: typeof result };
  }

  const { loaded, error } = result;

  return {
    type: Array.isArray(result) ? 'array' : 'object',
    ...(typeof loaded === 'boolean' ? { loaded } : {}),
    ...(error instanceof Error ? { error: { name: error.name, message: error.message } } : {}),
  };
};

const writeTimingTrace = (
  expectedUpdateCount: number,
  updateCount: number,
  renderHistory: TimingTraceState[],
  currentResult: unknown,
  outcome: 'resolved' | 'timed-out',
) => {
  if (!timingTraceEnabled) {
    return;
  }

  try {
    const traceDirectory = process.env.FEATURE_STORE_TIMING_TRACE_DIR;
    if (!traceDirectory) {
      return;
    }
    const { currentTestName, testPath } = expect.getState();
    mkdirSync(traceDirectory, { recursive: true });
    appendFileSync(
      join(traceDirectory, `hook-update-${process.pid}.jsonl`),
      `${JSON.stringify({
        testPath,
        currentTestName,
        outcome,
        expectedUpdateCount,
        updateCount,
        renderHistory,
        currentResult: getTimingTraceState(currentResult),
      })}\n`,
    );
  } catch {
    // Diagnostics must never alter a test's result.
  }
};

/**
 * Wrapper on top of RTL `renderHook` returning a result that implements the `RenderHookResultExt` interface.
 *
 * `renderHook` provides full control over the rendering of your hook including the ability to wrap the test component.
 * This is usually used to add context providers from `React.createContext` for the hook to access with `useContext`.
 * `initialProps` and props subsequently set by `rerender` will be provided to the wrapper.
 *
 * ```
 * const renderResult = renderHook(({ who }: { who: string }) => useSayHello(who), { initialProps: { who: 'world' }});
 * expect(renderResult).hookToBe('Hello world!');
 * renderResult.rerender({ who: 'there' });
 * expect(renderResult).hookToBe('Hello there!');
 * ```
 */
export const renderHook = <
  Result,
  Props,
  Q extends Queries = typeof queries,
  Container extends Element | DocumentFragment = HTMLElement,
  BaseElement extends Element | DocumentFragment = Container,
>(
  render: (initialProps: Props) => Result,
  options?: RenderHookOptions<Props, Q, Container, BaseElement>,
): RenderHookResultExt<Result, Props> => {
  let updateCount = 0;
  let prevResult: Result;
  let currentResult: Result;
  const renderHistory: TimingTraceState[] = [];

  const renderResult = renderHookRTL((props) => {
    updateCount++;
    prevResult = currentResult;
    currentResult = render(props);
    if (timingTraceEnabled) {
      renderHistory.push(getTimingTraceState(currentResult));
    }
    return currentResult;
  }, options);

  const renderResultExt: RenderHookResultExt<Result, Props> = {
    ...renderResult,

    getPreviousResult: () => (updateCount > 1 ? prevResult : renderResult.result.current),

    getUpdateCount: () => updateCount,

    waitForNextUpdate: async (currentOptions) => {
      const expected = updateCount;
      try {
        await waitFor(() => expect(updateCount).toBeGreaterThan(expected), currentOptions);
      } catch {
        writeTimingTrace(
          expected,
          updateCount,
          renderHistory,
          renderResult.result.current,
          'timed-out',
        );
        throw new Error('waitForNextUpdate timed out');
      }
      writeTimingTrace(
        expected,
        updateCount,
        renderHistory,
        renderResult.result.current,
        'resolved',
      );
    },
  };

  return renderResultExt;
};

/**
 * Lightweight API for testing a single hook.
 *
 * Prefer this method of testing over `renderHook` for simplicity.
 *
 * ```
 * const renderResult = testHook(useSayHello)('world');
 * expect(renderResult).hookToBe('Hello world!');
 * renderResult.rerender('there');
 * expect(renderResult).hookToBe('Hello there!');
 * ```
 */
export const testHook =
  <Result, P extends unknown[]>(hook: (...params: P) => Result) =>
  // not ideal to nest functions in terms of API but cannot find a better way to infer P from hook and not initialParams
  (
    ...initialParams: P
  ): Omit<RenderHookResultExt<Result, { $params: typeof initialParams }>, 'rerender'> & {
    rerender: (...params: typeof initialParams) => void;
  } => {
    const renderResult = renderHook<Result, { $params: typeof initialParams }>(
      ({ $params }) => hook(...$params),
      {
        initialProps: {
          $params: initialParams,
        },
      },
    );

    return {
      ...renderResult,
      rerender: (...params) => renderResult.rerender({ $params: params }),
    };
  };

/**
 * @deprecated use useFetch instead of useFetchState, and standardUseFetchStateObject instead of standardUseFetchState
 *
 * A helper function for asserting the return value of hooks based on `useFetchState`.
 *
 * eg.
 * ```
 * expect(renderResult).hookToStrictEqual(standardUseFetchState('test value', true))
 * ```
 * is equivalent to:
 * ```
 * expect(renderResult).hookToStrictEqual(['test value', true, undefined, expect.any(Function)])
 * ```
 */
export const standardUseFetchState = <D>(
  data: D,
  loaded = false,
  error?: Error,
): [
  data: D,
  loaded: boolean,
  loadError: Error | undefined,
  refresh: () => Promise<D | undefined>,
] => [data, loaded, error, expect.any(Function)];

/**
 * A helper function for asserting the return value of hooks based on `useFetch`.
 *
 * eg.
 * ```
 * expect(renderResult).hookToStrictEqual(standardUseFetchState('test value', true))
 * ```
 * is equivalent to:
 * ```
 * expect(renderResult).hookToStrictEqual({ data: 'test value', loaded: true, error: undefined, refresh: expect.any(Function) })
 * ```
 */
export const standardUseFetchStateObject = <D>({
  data,
  loaded = false,
  error,
}: {
  data: D;
  loaded?: boolean;
  error?: Error;
}): {
  data: D;
  loaded: boolean;
  error: Error | undefined;
  refresh: () => Promise<D | undefined>;
} => ({ data, loaded, error, refresh: expect.any(Function) });

// create a new asymmetric matcher that matches everything
const everything = () => {
  const r = expect.anything();
  r.asymmetricMatch = () => true;
  return r;
};

/**
 * Extracts a subset of values from the source that can be used to compare equality.
 *
 * Recursively traverses the `booleanTarget`. For every property or array index equal to `true`,
 * adds the value of the source to the result wrapped in custom matcher `expect.isIdentityEqual`.
 * If the entry is `false` or `undefined`, add an everything matcher to the result.
 */
export const createComparativeValue = <T>(source: T, booleanTarget: BooleanValues<T>): unknown =>
  createComparativeValueRecursive(source, booleanTarget);

const createComparativeValueRecursive = <T>(
  source: unknown,
  // eslint-disable-next-line @typescript-eslint/ban-types
  booleanTarget: boolean | string | number | Function | BooleanValues<T>,
) => {
  if (typeof booleanTarget === 'boolean') {
    return booleanTarget ? expect.isIdentityEqual(source) : everything();
  }
  if (Array.isArray(booleanTarget)) {
    if (Array.isArray(source)) {
      const r = new Array(source.length).fill(everything());
      booleanTarget.forEach((b, i) => {
        if (b != null) {
          r[i] = createComparativeValueRecursive(source[i], b);
        }
      });
      return r;
    }
    return undefined;
  }
  if (
    source == null ||
    typeof source === 'string' ||
    typeof source === 'number' ||
    typeof source === 'function'
  ) {
    return source;
  }
  const obj: { [k: string]: unknown } = {};
  if (booleanTarget) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const btObj = booleanTarget as { [k: string]: unknown };
    Object.keys(btObj).forEach((key) => {
      obj[key] = createComparativeValueRecursive(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions
        (source as any)[key] as unknown,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions
        btObj[key] as any,
      );
    });
  }
  return expect.objectContaining(obj);
};
