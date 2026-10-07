import { Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  RDSDatabaseRunningScheduler,
  type RDSDatabaseRunningSchedulerProps,
} from './rds-database-running-scheduler';

/**
 * Properties for the RDS database running schedule stack.
 *
 * Scheduler fields match {@link RDSDatabaseRunningSchedulerProps}.
 * The remaining fields are the standard stack settings from `StackProps`, such as `env`.
 */
export interface RDSDatabaseRunningScheduleStackProps extends RDSDatabaseRunningSchedulerProps, StackProps {}

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
