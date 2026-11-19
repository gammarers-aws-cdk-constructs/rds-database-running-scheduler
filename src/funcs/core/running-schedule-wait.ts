/**
 * Pure wait decisions for a single RDS resource.
 *
 * These helpers do not read the clock, environment, or AWS SDK. The Lambda
 * applies the returned step: finish or pause for one interval. An unexpected
 * status or an exhausted wait budget is reported by throwing a package error.
 */
import {
  RdsDatabaseRunningSchedulerStatusError,
  RdsDatabaseRunningSchedulerTimeoutError,
  RdsDatabaseRunningSchedulerValidateError,
} from './running-schedule-errors';
import {
  MAX_WAIT_SECONDS_LIMIT,
  RUNNING_MODE_START,
  RUNNING_MODE_STOP,
  type RunningMode,
} from '../../settings/consts';

/**
 * Status labels the wait decisions compare against.
 * `NOT_FOUND` is not an RDS status. The handler reports it when the resource is gone.
 */
export const RESOURCE_STATUS = {
  AVAILABLE: 'available',
  STOPPED: 'stopped',
  NOT_FOUND: 'not-found',
} as const;

/** RDS status while an automatic backup is running. */
export const BACKING_UP_STATUS = 'backing-up';

/**
 * Whether this run has already called the stop API for the resource.
 * A boolean is not used, so the two cases stay explicit.
 */
export const STOP_REQUEST = {
  /** Stop has not been called yet. */
  NOT_SENT: 'not-sent',
  /** Stop has been called and the run is waiting for `stopped`. */
  SENT: 'sent',
} as const;

/** Whether this run has already called the stop API for the resource. */
export type StopRequest = typeof STOP_REQUEST[keyof typeof STOP_REQUEST];

/**
 * RDS statuses that indicate an in-progress transition.
 *
 * A stop moves through `stopping` and `storage-optimization` before `stopped`.
 * `configuring-iam-database-auth` and `configuring-log-exports` are transitional
 * as well. The caller waits while any of these is current and does not issue
 * start or stop. A start that sees `storage-optimization` waits until a later
 * observation is `stopped`, then the `stopped` action issues start.
 * `backing-up` is included so a start, and a stop that was already requested,
 * keep waiting. A stop that has not been requested yet defers instead.
 */
export const TRANSITIONING_STATES = [
  'starting',
  'configuring-enhanced-monitoring',
  BACKING_UP_STATUS,
  'modifying',
  'stopping',
  'storage-optimization',
  'configuring-iam-database-auth',
  'configuring-log-exports',
] as const;

const TRANSITIONING_STATE_SET = new Set<string>(TRANSITIONING_STATES);

/**
 * Next action for one observed status, before the wait budget is applied.
 */
export type ResourceAction = 'not-found' | 'done' | 'start' | 'stop' | 'wait' | 'defer' | 'unexpected';

/**
 * Whether the status-check loop should run another iteration.
 */
export type WaitLoopSignal = 'open' | 'settled';

/**
 * Command to issue before pausing, when the resource is not yet terminal.
 */
export type WaitCommand = 'start' | 'stop' | 'none';

/**
 * One decision after reading the current RDS status.
 */
export type WaitStep =
  | {
    readonly kind: 'finish';
    readonly status: 'skipped' | 'deferred' | typeof RESOURCE_STATUS.AVAILABLE | typeof RESOURCE_STATUS.STOPPED;
    /** Why a stop was deferred. Absent for a completed or missing resource. */
    readonly reason?: string;
  }
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
 * One observed status, plus whether stop was already requested.
 */
export interface ResourceObservation {
  /** Requested operation mode. */
  readonly mode: RunningMode;
  /** Current RDS status, or `not-found` when the resource is gone. */
  readonly current: string;
  /** Whether this run has already called the stop API. */
  readonly stopRequest: StopRequest;
}

/**
 * Returns whether a stop should wait for the next schedule instead of this run.
 *
 * @param observation Current status and whether stop was already requested.
 * @returns `true` when stop has not been called and the database is backing up.
 */
const shouldDeferStop = (observation: ResourceObservation): boolean =>
  observation.mode === RUNNING_MODE_STOP
  && observation.current === BACKING_UP_STATUS
  && observation.stopRequest === STOP_REQUEST.NOT_SENT;

const resourceKindLabel = (type: 'db' | 'cluster'): string => {
  if (type === 'db') {
    return 'DB';
  }
  return 'cluster';
};

/**
 * Reason stored when a stop is left for the next schedule.
 *
 * @param type Resource kind.
 * @param identifier DB instance or cluster identifier.
 * @returns Reason recorded on the execution result and in Slack.
 */
const stopDeferredReason = (type: 'db' | 'cluster', identifier: string): string =>
  `Stop deferred for ${resourceKindLabel(type)} ${identifier}: status is backing-up. The next stop schedule will try again.`;

/**
 * Maps an RDS status to the next action for the requested mode.
 *
 * A stop that still has not been requested defers while the database is
 * backing up, so a long automatic backup does not use the wait budget.
 * After stop has been requested, `backing-up` is an ordinary transition.
 *
 * @param observation Current status and whether stop was already requested.
 * @returns Action to take before considering the wait budget.
 */
export const decideResourceAction = (observation: ResourceObservation): ResourceAction => {
  const { mode, current } = observation;
  if (current === RESOURCE_STATUS.NOT_FOUND) {
    return 'not-found';
  }
  if (mode === RUNNING_MODE_START && current === RESOURCE_STATUS.AVAILABLE) {
    return 'done';
  }
  if (mode === RUNNING_MODE_STOP && current === RESOURCE_STATUS.STOPPED) {
    return 'done';
  }
  if (mode === RUNNING_MODE_START && current === RESOURCE_STATUS.STOPPED) {
    return 'start';
  }
  if (mode === RUNNING_MODE_STOP && current === RESOURCE_STATUS.AVAILABLE) {
    return 'stop';
  }
  if (shouldDeferStop(observation)) {
    return 'defer';
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
 * Options for {@link nextWaitStep}.
 */
export interface NextWaitStepOptions {
  /** Requested operation mode. */
  readonly mode: RunningMode;
  /** Current RDS status, or `not-found` when the resource is gone. */
  readonly current: string;
  /** Seconds already spent waiting for this resource. */
  readonly elapsedWaitSeconds: number;
  /** Seconds the next wait would add. */
  readonly intervalSeconds: number;
  /** Maximum accumulated wait seconds for this resource. */
  readonly maxWaitSeconds: number;
  /** Resource description embedded in error messages, e.g. `type=db identifier=my-db`. */
  readonly resourceLabel: string;
  /** Resource kind used in a deferred-stop reason. */
  readonly type: 'db' | 'cluster';
  /** DB instance or cluster identifier used in a deferred-stop reason. */
  readonly identifier: string;
  /** Whether this run has already called the stop API. */
  readonly stopRequest: StopRequest;
}

/**
 * Chooses the next step from the current status and remaining wait budget.
 *
 * A stable or missing resource finishes even when the budget is exhausted.
 * A stop that has not been requested finishes as deferred while the database
 * is backing up, including when the wait budget is already exhausted.
 * Start, stop, and transitioning statuses throw when the next interval
 * would exceed the maximum.
 *
 * @param options Current observation and wait budget for one resource.
 * @returns Finish, or pause for one interval.
 * @throws {RdsDatabaseRunningSchedulerStatusError} When the status cannot be handled for the mode.
 * @throws {RdsDatabaseRunningSchedulerTimeoutError} When the next interval would exceed the wait budget.
 */
export const nextWaitStep = (options: NextWaitStepOptions): WaitStep => {
  const {
    mode,
    current,
    elapsedWaitSeconds,
    intervalSeconds,
    maxWaitSeconds,
    resourceLabel,
    type,
    identifier,
    stopRequest,
  } = options;
  const action = decideResourceAction({ mode, current, stopRequest });
  if (action === 'not-found') {
    return { kind: 'finish', status: 'skipped' };
  }
  if (action === 'done' && (current === RESOURCE_STATUS.AVAILABLE || current === RESOURCE_STATUS.STOPPED)) {
    return { kind: 'finish', status: current };
  }
  if (action === 'defer') {
    return { kind: 'finish', status: 'deferred', reason: stopDeferredReason(type, identifier) };
  }
  if (action === 'unexpected' || action === 'done') {
    throw new RdsDatabaseRunningSchedulerStatusError(
      `db instance or cluster status fail: ${resourceLabel} current=${current}`,
    );
  }
  if (!hasWaitBudget(elapsedWaitSeconds, intervalSeconds, maxWaitSeconds)) {
    throw new RdsDatabaseRunningSchedulerTimeoutError(
      `wait timed out: ${resourceLabel} maxWaitSeconds=${maxWaitSeconds}`,
    );
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
 * @returns `true` only while no result has been recorded.
 */
export const shouldContinueWaitLoop = (signal: WaitLoopSignal): boolean => signal === 'open';

/**
 * Validates per-resource wait settings for the handler.
 *
 * @param intervalSeconds Seconds between status checks.
 * @param maxSeconds Maximum accumulated wait seconds for one resource.
 * @returns The same values when they are valid.
 * @throws {RdsDatabaseRunningSchedulerValidateError} When either value is not a positive integer,
 * when `maxSeconds` is less than `intervalSeconds`, or when `maxSeconds` exceeds the shared limit.
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
