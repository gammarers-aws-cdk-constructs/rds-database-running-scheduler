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
