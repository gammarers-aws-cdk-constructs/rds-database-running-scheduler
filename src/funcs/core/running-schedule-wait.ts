/**
 * Pure wait decisions for a single RDS resource.
 *
 * These helpers do not read the clock, environment, or AWS SDK. The Lambda
 * applies the returned step: finish, fail, time out, or pause for one interval.
 */
import { RdsDatabaseRunningSchedulerValidateError } from './running-schedule-errors';
import { MAX_WAIT_SECONDS_LIMIT } from '../../settings/consts';

/**
 * RDS statuses that indicate an in-progress transition.
 */
export const TRANSITIONING_STATES = [
  'starting',
  'configuring-enhanced-monitoring',
  'backing-up',
  'modifying',
  'stopping',
] as const;

const TRANSITIONING_STATE_SET = new Set<string>(TRANSITIONING_STATES);

/**
 * Next action for one observed status, before the wait budget is applied.
 */
export type ResourceAction = 'not-found' | 'done' | 'start' | 'stop' | 'wait' | 'unexpected';

/**
 * Whether the status-check loop should run another iteration.
 */
export type WaitLoopSignal = 'open' | 'settled' | 'failed';

/**
 * Command to issue before pausing, when the resource is not yet terminal.
 */
export type WaitCommand = 'start' | 'stop' | 'none';

/**
 * One decision after reading the current RDS status.
 */
export type WaitStep =
  | { readonly kind: 'finish'; readonly status: 'skipped' | 'available' | 'stopped' }
  | { readonly kind: 'fail'; readonly current: string }
  | { readonly kind: 'timed-out' }
  | { readonly kind: 'pause'; readonly command: WaitCommand };

/**
 * Validated per-resource wait settings.
 */
export interface ResolvedResourceWait {
  /** Seconds between status checks. */
  readonly intervalSeconds: number;
  /** Maximum accumulated wait seconds for one resource. */
  readonly maxSeconds: number;
}

/**
 * Returns whether `current` is an in-progress RDS transition.
 *
 * @param current RDS status string.
 * @returns `true` when the status is a known transitioning state.
 */
export const isTransitioningState = (current: string): boolean =>
  TRANSITIONING_STATE_SET.has(current);

/**
 * Maps an RDS status to the next action for the requested mode.
 *
 * @param mode Requested operation mode.
 * @param current Current RDS status, or `not-found` when the resource is gone.
 * @returns Action to take before considering the wait budget.
 */
export const decideResourceAction = (
  mode: 'Start' | 'Stop',
  current: string,
): ResourceAction => {
  if (current === 'not-found') {
    return 'not-found';
  }
  if (mode === 'Start' && current === 'available') {
    return 'done';
  }
  if (mode === 'Stop' && current === 'stopped') {
    return 'done';
  }
  if (mode === 'Start' && current === 'stopped') {
    return 'start';
  }
  if (mode === 'Stop' && current === 'available') {
    return 'stop';
  }
  if (isTransitioningState(current)) {
    return 'wait';
  }
  return 'unexpected';
};

/**
 * Returns whether another wait of `intervalSeconds` still fits in the budget.
 *
 * @param elapsedWaitSeconds Seconds already spent in `context.wait` for this resource.
 * @param intervalSeconds Seconds the next wait would add.
 * @param maxWaitSeconds Maximum accumulated wait seconds for this resource.
 * @returns `true` when `elapsedWaitSeconds + intervalSeconds` does not exceed the maximum.
 */
export const hasWaitBudget = (
  elapsedWaitSeconds: number,
  intervalSeconds: number,
  maxWaitSeconds: number,
): boolean => elapsedWaitSeconds + intervalSeconds <= maxWaitSeconds;

/**
 * Chooses the next step from the current status and remaining wait budget.
 *
 * A stable or missing resource finishes even when the budget is exhausted.
 * Start, stop, and transitioning statuses time out when the next interval
 * would exceed the maximum.
 *
 * @param mode Requested operation mode.
 * @param current Current RDS status, or `not-found` when the resource is gone.
 * @param elapsedWaitSeconds Seconds already spent waiting for this resource.
 * @param intervalSeconds Seconds the next wait would add.
 * @param maxWaitSeconds Maximum accumulated wait seconds for this resource.
 * @returns Finish, fail, time out, or pause for one interval.
 */
export const nextWaitStep = (
  mode: 'Start' | 'Stop',
  current: string,
  elapsedWaitSeconds: number,
  intervalSeconds: number,
  maxWaitSeconds: number,
): WaitStep => {
  const action = decideResourceAction(mode, current);
  if (action === 'not-found') {
    return { kind: 'finish', status: 'skipped' };
  }
  if (action === 'done' && (current === 'available' || current === 'stopped')) {
    return { kind: 'finish', status: current };
  }
  if (action === 'unexpected' || action === 'done') {
    return { kind: 'fail', current };
  }
  if (!hasWaitBudget(elapsedWaitSeconds, intervalSeconds, maxWaitSeconds)) {
    return { kind: 'timed-out' };
  }
  if (action === 'start') {
    return { kind: 'pause', command: 'start' };
  }
  if (action === 'stop') {
    return { kind: 'pause', command: 'stop' };
  }
  return { kind: 'pause', command: 'none' };
};

/**
 * Returns whether the status-check loop should keep running.
 *
 * @param signal Loop signal after the latest status check.
 * @returns `true` only while no result and no failure have been recorded.
 */
export const shouldContinueWaitLoop = (signal: WaitLoopSignal): boolean => signal === 'open';

/**
 * Validates per-resource wait settings for the handler.
 *
 * @param intervalSeconds Seconds between status checks.
 * @param maxSeconds Maximum accumulated wait seconds for one resource.
 * @returns The same values when they are valid.
 * @throws {RdsDatabaseRunningSchedulerValidateError} When either value is not a positive integer, when `maxSeconds` is less than `intervalSeconds`, or when `maxSeconds` exceeds the shared limit.
 */
export const resolveResourceWait = (
  intervalSeconds: number,
  maxSeconds: number,
): ResolvedResourceWait => {
  if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
    throw new RdsDatabaseRunningSchedulerValidateError(
      'resourceWait.intervalSeconds must be a positive integer',
    );
  }
  if (!Number.isInteger(maxSeconds) || maxSeconds <= 0) {
    throw new RdsDatabaseRunningSchedulerValidateError(
      'resourceWait.maxSeconds must be a positive integer',
    );
  }
  if (maxSeconds < intervalSeconds) {
    throw new RdsDatabaseRunningSchedulerValidateError(
      'resourceWait.maxSeconds must be greater than or equal to resourceWait.intervalSeconds',
    );
  }
  if (maxSeconds > MAX_WAIT_SECONDS_LIMIT) {
    throw new RdsDatabaseRunningSchedulerValidateError(
      `resourceWait.maxSeconds must be less than or equal to ${MAX_WAIT_SECONDS_LIMIT}`,
    );
  }
  return { intervalSeconds, maxSeconds };
};
