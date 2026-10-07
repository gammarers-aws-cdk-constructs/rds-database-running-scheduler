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
 * Wait settings read by the handler are not positive integers within the limit.
 */
export class RdsDatabaseRunningSchedulerValidateError extends RdsDatabaseRunningSchedulerError {
  override readonly name: string = 'RdsDatabaseRunningSchedulerValidateError';

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, RdsDatabaseRunningSchedulerValidateError.prototype);
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
