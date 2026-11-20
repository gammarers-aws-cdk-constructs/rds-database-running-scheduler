/**
 * Errors thrown by the running-schedule handler.
 *
 * These types stay inside the handler. The jsii entry does not re-export them,
 * and synthesis-time checks in the construct throw a plain `Error` instead.
 */

/**
 * Base error for failures raised by the running-schedule handler.
 */
export abstract class RdsDatabaseRunningSchedulerError extends Error {
  override readonly name: string = 'RdsDatabaseRunningSchedulerError';

  protected constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, RdsDatabaseRunningSchedulerError.prototype);
  }
}

/**
 * Input the handler refuses before it changes a resource.
 *
 * Thrown when the schedule event is missing `Params`, when a region is blank,
 * when wait settings are not positive integers within the limit, or when
 * `TARGET_REGIONS` is not a JSON array of distinct region names that are
 * enabled for the account.
 */
export class RdsDatabaseRunningSchedulerValidateError extends RdsDatabaseRunningSchedulerError {
  override readonly name: string = 'RdsDatabaseRunningSchedulerValidateError';

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, RdsDatabaseRunningSchedulerValidateError.prototype);
  }
}

/**
 * A resource reported a status that neither finishes nor continues the requested operation.
 */
export class RdsDatabaseRunningSchedulerStatusError extends RdsDatabaseRunningSchedulerError {
  override readonly name: string = 'RdsDatabaseRunningSchedulerStatusError';

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, RdsDatabaseRunningSchedulerStatusError.prototype);
  }
}

/**
 * A resource did not reach its target state within the wait budget.
 */
export class RdsDatabaseRunningSchedulerTimeoutError extends RdsDatabaseRunningSchedulerError {
  override readonly name: string = 'RdsDatabaseRunningSchedulerTimeoutError';

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, RdsDatabaseRunningSchedulerTimeoutError.prototype);
  }
}
