import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { RDSDatabaseRunningScheduler, TargetResource, Schedule, Notification } from '../constructs/rds-database-running-scheduler';

/**
 * Properties for the RDS database running schedule stack.
 */
export interface RDSDatabaseRunningScheduleStackProps extends StackProps {
  /** Tag filter used to select target RDS resources. */
  readonly targetResource: TargetResource;
  /**
   * Optional notification channels.
   * Set `notification.slack` to enable Slack; omit it to skip secret lookup,
   * Slack API calls, and related IAM grants.
   */
  readonly notification?: Notification;
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
 * execution, and optional Slack notifications to {@link RDSDatabaseRunningScheduler}.
 */
export class RDSDatabaseRunningScheduleStack extends Stack {
  /**
   * Creates the stack and instantiates the scheduler construct.
   *
   * @param scope Parent construct scope.
   * @param id Stack identifier.
   * @param props Stack configuration, including optional notification channels.
   */
  constructor(scope: Construct, id: string, props: RDSDatabaseRunningScheduleStackProps) {
    super(scope, id, props);

    new RDSDatabaseRunningScheduler(this, 'RDSDatabaseRunningScheduler', {
      targetResource: props.targetResource,
      enableScheduling: props.enableScheduling,
      notification: props.notification,
      stopSchedule: props.stopSchedule,
      startSchedule: props.startSchedule,
    });
  }
}
