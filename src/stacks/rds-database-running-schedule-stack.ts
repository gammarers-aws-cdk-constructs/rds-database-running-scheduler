import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  RDSDatabaseRunningScheduler,
  type Notification,
  type ResourceWait,
  type Schedule,
  type TargetResource,
} from '../constructs/rds-database-running-scheduler';

/**
 * Properties for the RDS database running schedule stack.
 */
export interface RDSDatabaseRunningScheduleStackProps extends StackProps {
  /** Tag filter used to select target RDS resources. */
  readonly targetResource: TargetResource;
  /**
   * Optional notification channels.
   * Set `notification.slack.enable` to `true` and provide `secretName` to send Slack messages.
   */
  readonly notification?: Notification;
  /**
   * Optional per-resource wait settings.
   * Defaults to a 60-second interval and a 1800-second maximum.
   */
  readonly resourceWait?: ResourceWait;
  /** Enables or disables both start and stop schedules. Default: `true`. */
  readonly enableScheduling?: boolean;
  /** Optional cron configuration for stop operations. */
  readonly stopSchedule?: Schedule;
  /** Optional cron configuration for start operations. */
  readonly startSchedule?: Schedule;
}

/**
 * CDK stack that provisions scheduled start/stop control for tagged RDS resources
 * in the deployment account.
 *
 * Delegates resource discovery, cluster-priority deduplication, start/stop
 * execution, per-resource wait limits, and optional Slack notifications to
 * {@link RDSDatabaseRunningScheduler}.
 */
export class RDSDatabaseRunningScheduleStack extends Stack {
  /**
   * Creates the stack and instantiates the scheduler construct.
   *
   * @param scope Parent construct scope.
   * @param id Stack identifier.
   * @param props Stack configuration, including optional Slack notification settings.
   */
  constructor(scope: Construct, id: string, props: RDSDatabaseRunningScheduleStackProps) {
    super(scope, id, props);

    new RDSDatabaseRunningScheduler(this, 'RDSDatabaseRunningScheduler', {
      targetResource: props.targetResource,
      enableScheduling: props.enableScheduling,
      notification: props.notification,
      resourceWait: props.resourceWait,
      stopSchedule: props.stopSchedule,
      startSchedule: props.startSchedule,
    });
  }
}
