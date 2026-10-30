/**
 * Settings shared by the construct and the running-schedule handler.
 *
 * Put values both sides must agree on here. Each caller validates them and
 * throws its own error type.
 */

/** Default seconds between status checks. */
export const DEFAULT_WAIT_INTERVAL_SECONDS = 60;

/** Default maximum wait seconds for one resource. */
export const DEFAULT_MAX_WAIT_SECONDS = 1800;

/**
 * Upper bound for the per-resource wait.
 * Stays under the 2-hour durable execution timeout so this limit fires first.
 */
export const MAX_WAIT_SECONDS_LIMIT = 6900;

/** Schedule input `Mode` that starts the matched resources. */
export const RUNNING_MODE_START = 'Start';

/** Schedule input `Mode` that stops the matched resources. */
export const RUNNING_MODE_STOP = 'Stop';

/**
 * Operation requested by a schedule.
 * The construct writes it into the schedule input and the handler reads it.
 */
export type RunningMode = typeof RUNNING_MODE_START | typeof RUNNING_MODE_STOP;

/**
 * Log markers for failure detection.
 *
 * The handler writes each marker at the start of an ERROR log message and the
 * construct builds its CloudWatch Logs filter patterns from the same values,
 * so a marker is renamed in one place.
 */

/** Logged when a resource did not reach its target state within the wait budget. */
export const LOG_MARKER_RESOURCE_WAIT_TIMED_OUT = 'ResourceWaitTimedOut';

/** Logged when a resource reports a status that cannot be handled for the requested mode. */
export const LOG_MARKER_RESOURCE_STATUS_UNEXPECTED = 'ResourceStatusUnexpected';

/** Logged once when the whole scheduled execution fails for any reason. */
export const LOG_MARKER_SCHEDULE_EXECUTION_FAILED = 'ScheduleExecutionFailed';
