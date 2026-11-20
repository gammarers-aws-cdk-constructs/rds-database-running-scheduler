/**
 * Pure decisions for a durable map over scheduled RDS resources.
 *
 * These helpers do not read the clock, environment, or AWS SDK. The Lambda
 * chooses a completion mode, passes the per-resource outcomes, and fails the
 * execution when any resource failed.
 */

/** How a durable map treats an item failure. */
export const MAP_COMPLETION = {
  /** Stop at the first failure. Omits completion config so the SDK default applies. */
  FAIL_FAST: 'fail-fast',
  /** Run every item, then report failures together. */
  CONTINUE: 'continue',
} as const;

/** Completion mode for a durable map. */
export type MapCompletion = typeof MAP_COMPLETION[keyof typeof MAP_COMPLETION];

/**
 * Maximum number of failed resource names included in the execution error.
 * The log still lists every failed resource.
 */
export const MAP_FAILURE_NAME_LIMIT = 10;

/** Outcome of one map item after the batch finishes. */
export type MapItemState = 'succeeded' | 'failed' | 'not-started';

/** One resource after the map finishes. */
export interface MapItemOutcome {
  /** Resource identifier shown in logs and the execution error. */
  readonly name: string;
  /** Whether the item succeeded, failed, or never finished. */
  readonly state: MapItemState;
}

/** Status recorded for an item the batch actually observed. */
export type ObservedMapItemState = 'succeeded' | 'failed' | 'started';

/** One item the batch reported, addressed by its input index. */
export interface ObservedMapItem {
  /** Index in the input list. */
  readonly index: number;
  /** Status the batch recorded for that index. */
  readonly state: ObservedMapItemState;
}

/**
 * Completion config for a durable map.
 *
 * `continue` waits for every item. `fail-fast` returns `undefined` so the
 * caller leaves the SDK default in place.
 *
 * @param completion How item failures should end the map.
 * @returns Config that waits for every item, or `undefined` for the SDK default.
 */
export const mapCompletionConfig = (
  completion: MapCompletion,
): { readonly toleratedFailurePercentage: number } | undefined => {
  if (completion === MAP_COMPLETION.CONTINUE) {
    return { toleratedFailurePercentage: 100 };
  }
  return undefined;
};

/**
 * Returns whether any mapped resource failed.
 *
 * @param items Outcomes in input order.
 * @returns `true` when at least one item failed.
 */
export const hasMapFailure = (items: readonly MapItemOutcome[]): boolean =>
  items.some((item) => item.state === 'failed');

/**
 * Lists failed resource names in input order.
 *
 * @param items Outcomes in input order.
 * @returns Names of the failed items.
 */
export const failedMapItemNames = (items: readonly MapItemOutcome[]): string[] =>
  items.filter((item) => item.state === 'failed').map((item) => item.name);

/**
 * Counts resources the batch stopped before they finished.
 *
 * @param items Outcomes in input order.
 * @returns Number of items that were not started or were abandoned in flight.
 */
export const notStartedMapItemCount = (items: readonly MapItemOutcome[]): number =>
  items.filter((item) => item.state === 'not-started').length;

/** Failed names chosen for an execution error. */
export interface MapFailureNameList {
  /** Failed names included in the execution error. */
  readonly shown: readonly string[];
  /** Failed names omitted because of the limit. */
  readonly hiddenCount: number;
}

/**
 * Chooses the failed names that fit in an execution error.
 *
 * @param names Failed resource names, in input order.
 * @param limit Maximum number of names to include.
 * @returns The names to show and how many were left out.
 */
export const mapFailureNamesForMessage = (
  names: readonly string[],
  limit: number,
): MapFailureNameList => {
  const shown = names.slice(0, limit);
  if (names.length > limit) {
    return { shown, hiddenCount: names.length - limit };
  }
  return { shown, hiddenCount: 0 };
};

const resourceCount = (count: number): string => {
  if (count === 1) {
    return '1 resource';
  }
  return `${count} resources`;
};

const notStartedSentence = (count: number): string => {
  if (count === 1) {
    return '1 resource was not started.';
  }
  return `${count} resources were not started.`;
};

/**
 * Builds the execution error used when any mapped resource failed.
 *
 * The message names at most {@link MAP_FAILURE_NAME_LIMIT} failed resources.
 * When the batch stopped early, it also reports how many resources never finished.
 *
 * @param items Outcomes in input order.
 * @returns Error message for the whole execution.
 */
export const mapFailureMessage = (items: readonly MapItemOutcome[]): string => {
  const failed = failedMapItemNames(items);
  const listed = mapFailureNamesForMessage(failed, MAP_FAILURE_NAME_LIMIT);
  const names = listed.hiddenCount === 0
    ? listed.shown.join(', ')
    : `${listed.shown.join(', ')}, and ${listed.hiddenCount} more`;
  const failure = `${resourceCount(failed.length)} failed: ${names}`;
  const notStarted = notStartedMapItemCount(items);
  if (notStarted === 0) {
    return failure;
  }
  return `${failure}. ${notStartedSentence(notStarted)}`;
};

/**
 * Aligns batch observations with the input list.
 *
 * An index the batch did not report, and an item still marked started, both
 * count as not started. Those entries are what a fail-fast batch leaves behind.
 *
 * @param names Resource names in input order.
 * @param observed Items the batch reported.
 * @returns One outcome per input name.
 */
export const mapItemOutcomes = (
  names: readonly string[],
  observed: readonly ObservedMapItem[],
): MapItemOutcome[] => {
  const stateByIndex = new Map(observed.map((item) => [item.index, item.state]));
  return names.map((name, index) => {
    const state = stateByIndex.get(index);
    if (state === undefined || state === 'started') {
      return { name, state: 'not-started' };
    }
    if (state === 'failed') {
      return { name, state: 'failed' };
    }
    return { name, state: 'succeeded' };
  });
};
