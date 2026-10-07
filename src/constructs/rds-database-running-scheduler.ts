import { Aws, Duration, RemovalPolicy, TimeZone } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as targets from 'aws-cdk-lib/aws-scheduler-targets';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { RunningScheduleFunction } from '../funcs/running-schedule-function';
import {
  DEFAULT_MAX_WAIT_SECONDS,
  DEFAULT_WAIT_INTERVAL_SECONDS,
  resolveResourceWait,
} from '../funcs/running-schedule-wait';

/**
 * Cron schedule settings for EventBridge Scheduler.
 */
export interface Schedule {
  /** Time zone used to interpret cron fields. */
  readonly timezone: TimeZone;
  /** Minute field in cron expression. */
  readonly minute?: string;
  /** Hour field in cron expression. */
  readonly hour?: string;
  /** Weekday field in cron expression. */
  readonly week?: string;
}

/**
 * Tag filter used to discover target RDS resources.
 */
export interface TargetResource {
  /** Tag key used for resource discovery. */
  readonly tagKey: string;
  /** Tag values matched by the scheduler target query. */
  readonly tagValues: string[];
}

/**
 * Slack notification settings.
 * Notifications are off unless `enable` is `true`.
 */
export interface SlackNotification {
  /**
   * Whether Slack notifications are enabled.
   * When `false`, Secrets Manager lookup, Slack API calls, and related IAM grants are skipped.
   * @default false
   */
  readonly enable?: boolean;
  /**
   * Name of the Slack API secret in AWS Secrets Manager (`token` and `channel`).
   * Required when `enable` is `true`.
   */
  readonly secretName?: string;
  /**
   * Whether to post a Slack message when a resource exceeds `resourceWait.maxSeconds`.
   * Applies only when `enable` is `true`.
   * @default true
   */
  readonly notifyOnWaitTimeout?: boolean;
}

/**
 * Notification channel configuration for the scheduler workflow.
 * Omit a channel (or the whole object) to disable that channel.
 * Additional channels can be added here in the future without changing top-level props.
 */
export interface Notification {
  /** Optional Slack notification settings. Set `slack.enable` to `true` to send messages. */
  readonly slack?: SlackNotification;
}

/**
 * Per-resource wait settings for start/stop status checks.
 */
export interface ResourceWait {
  /**
   * Seconds between status checks while a resource is starting, stopping, or otherwise transitioning.
   * Must be a positive integer.
   * @default 60
   */
  readonly intervalSeconds?: number;
  /**
   * Maximum accumulated wait seconds for one resource to reach a stable state.
   * Must be a positive integer, greater than or equal to `intervalSeconds`, and at most 6900
   * so the limit fires before the 2-hour durable execution timeout.
   * @default 1800
   */
  readonly maxSeconds?: number;
}

/**
 * Properties for the RDS database running scheduler construct.
 */
export interface RDSDatabaseRunningSchedulerProps {
  /** Tag filter to select RDS instances and clusters. */
  readonly targetResource: TargetResource;
  /** Enables or disables both start and stop schedules. Default: `true`. */
  readonly enableScheduling?: boolean;
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
  /** Optional override for stop schedule cron configuration. */
  readonly stopSchedule?: Schedule;
  /** Optional override for start schedule cron configuration. */
  readonly startSchedule?: Schedule;
}

/**
 * Resolves whether Slack notifications are enabled and which secret to use.
 *
 * @param slack Slack channel settings from construct props.
 * @returns Enabled state with a secret name, or a disabled state.
 * @throws {Error} When `slack.enable` is `true` but `slack.secretName` is missing.
 */
const resolveSlackNotification = (
  slack: SlackNotification | undefined,
): { enabled: true; secretName: string; notifyOnWaitTimeout: boolean } | { enabled: false } => {
  if (!slack) {
    return { enabled: false };
  }
  if (slack.enable !== true) {
    return { enabled: false };
  }
  if (!slack.secretName) {
    throw new Error('notification.slack.secretName is required when notification.slack.enable is true');
  }
  return {
    enabled: true,
    secretName: slack.secretName,
    notifyOnWaitTimeout: slack.notifyOnWaitTimeout !== false,
  };
};

/**
 * Account-wide RDS DB instance and cluster ARNs used to scope start/stop IAM.
 * Region is `*` because tagged resources may live outside the stack region.
 *
 * @returns RDS resource ARNs for db instances and clusters in this account.
 */
const rdsControlResourceArns = (): string[] => [
  `arn:${Aws.PARTITION}:rds:*:${Aws.ACCOUNT_ID}:db:*`,
  `arn:${Aws.PARTITION}:rds:*:${Aws.ACCOUNT_ID}:cluster:*`,
];

/**
 * IAM condition that allows start/stop only on resources matching the target tag.
 *
 * @param targetResource Tag key and values used to select RDS resources.
 * @returns StringEquals condition keyed by `aws:ResourceTag/<tagKey>`.
 */
const rdsResourceTagCondition = (
  targetResource: TargetResource,
): Record<string, Record<string, string[]>> => ({
  StringEquals: {
    [`aws:ResourceTag/${targetResource.tagKey}`]: targetResource.tagValues,
  },
});

/**
 * CDK construct that provisions a durable Lambda workflow and EventBridge
 * schedules to start/stop tagged RDS databases and clusters.
 *
 * The Lambda discovers matching resources account-wide via the Resource Groups
 * Tagging API, deduplicates Aurora cluster member instances when the parent
 * cluster is also tagged, and controls each remaining resource using the
 * region encoded in its ARN. Each resource is checked on a configurable interval
 * until it reaches a stable state or the per-resource wait limit. When Slack is
 * enabled, the Lambda posts progress and results to Slack, and can post a timeout
 * message when the wait limit is exceeded. Otherwise Secrets Manager lookup, Slack
 * API calls, and related IAM grants are skipped.
 */
export class RDSDatabaseRunningScheduler extends Construct {
  /**
   * Creates a scheduler for tagged RDS resources.
   *
   * @param scope Parent construct scope.
   * @param id Construct identifier.
   * @param props Scheduler configuration, including optional Slack notification settings.
   */
  constructor(scope: Construct, id: string, props: RDSDatabaseRunningSchedulerProps) {
    super(scope, id);

    const slackNotification = resolveSlackNotification(props.notification?.slack);
    const resourceWait = resolveResourceWait(
      props.resourceWait?.intervalSeconds ?? DEFAULT_WAIT_INTERVAL_SECONDS,
      props.resourceWait?.maxSeconds ?? DEFAULT_MAX_WAIT_SECONDS,
    );
    let notifySlackOnWaitTimeout = false;
    if (slackNotification.enabled) {
      notifySlackOnWaitTimeout = slackNotification.notifyOnWaitTimeout;
    }

    // 👇 Lambda Function
    const runningScheduleFunction = new RunningScheduleFunction(this, 'RunningScheduleFunction', {
      description: 'A function to run the scheduled RDS Database or Cluster.',
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.minutes(15),
      memorySize: 512,
      retryAttempts: 2,
      durableConfig: {
        executionTimeout: Duration.hours(2),
        retentionPeriod: Duration.days(1),
      },
      environment: {
        WAIT_INTERVAL_SECONDS: String(resourceWait.intervalSeconds),
        MAX_WAIT_SECONDS: String(resourceWait.maxSeconds),
        NOTIFY_SLACK_ON_WAIT_TIMEOUT: notifySlackOnWaitTimeout ? 'true' : 'false',
        ...(slackNotification.enabled
          ? { SLACK_SECRET_NAME: slackNotification.secretName }
          : {}),
      },
      ...(slackNotification.enabled
        ? {
          paramsAndSecrets: lambda.ParamsAndSecretsLayerVersion.fromVersion(lambda.ParamsAndSecretsVersions.V1_0_103, {
            cacheSize: 500,
            logLevel: lambda.ParamsAndSecretsLogLevel.INFO,
          }),
        }
        : {}),
      role: new iam.Role(this, 'RunningScheduleFunctionRole', {
        description: 'A role to control the RDS Database or Cluster.',
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicDurableExecutionRolePolicy'),
        ],
      }),
      logGroup: new logs.LogGroup(this, 'RunningScheduleFunctionLogGroup', {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      loggingFormat: lambda.LoggingFormat.JSON,
      systemLogLevelV2: lambda.SystemLogLevel.INFO,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
    });
    runningScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
      sid: 'GetResources',
      effect: iam.Effect.ALLOW,
      actions: [
        'tag:GetResources',
      ],
      resources: ['*'],
    }));
    // DescribeDBInstances and DescribeDBClusters do not support resource-level IAM.
    runningScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
      sid: 'RdsDescribe',
      effect: iam.Effect.ALLOW,
      actions: [
        'rds:DescribeDBInstances',
        'rds:DescribeDBClusters',
      ],
      resources: ['*'],
    }));
    runningScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
      sid: 'RdsRunningControl',
      effect: iam.Effect.ALLOW,
      actions: [
        'rds:StartDBInstance',
        'rds:StartDBCluster',
        'rds:StopDBInstance',
        'rds:StopDBCluster',
      ],
      resources: rdsControlResourceArns(),
      conditions: rdsResourceTagCondition(props.targetResource),
    }));
    if (slackNotification.enabled) {
      const slackSecret = Secret.fromSecretNameV2(this, 'SlackSecret', slackNotification.secretName);
      slackSecret.grantRead(runningScheduleFunction);
    }

    // https://docs.aws.amazon.com/lambda/latest/dg/durable-getting-started-iac.html
    const runningScheduleFunctionAlias = runningScheduleFunction.addAlias('live');

    // 👇 Schedule state
    const scheduleEnabled: boolean = (() => {
      if (props.enableScheduling === undefined || props.enableScheduling) {
        return true;
      } else {
        return false;
      }
    })();

    // Schedule (Durable Functions: Lambda performs tag lookup, export, and polling in one run)
    new scheduler.Schedule(this, 'RunningStartSchedule', {
      description: 'running start schedule',
      enabled: scheduleEnabled,
      schedule: scheduler.ScheduleExpression.cron({
        minute: props.startSchedule?.minute ?? '50',
        hour: props.startSchedule?.hour ?? '7',
        weekDay: props.startSchedule?.week ?? 'MON-FRI',
        timeZone: props.startSchedule?.timezone ?? TimeZone.ETC_UTC,
      }),
      target: new targets.LambdaInvoke(runningScheduleFunctionAlias, {
        input: scheduler.ScheduleTargetInput.fromObject({
          Params: {
            TagKey: props.targetResource.tagKey,
            TagValues: props.targetResource.tagValues,
            Mode: 'Start',
          },
        }),
      }),
    });

    new scheduler.Schedule(this, 'RunningStopSchedule', {
      description: 'running stop schedule',
      enabled: scheduleEnabled,
      schedule: scheduler.ScheduleExpression.cron({
        minute: props.stopSchedule?.minute ?? '5',
        hour: props.stopSchedule?.hour ?? '19',
        weekDay: props.stopSchedule?.week ?? 'MON-FRI',
        timeZone: props.stopSchedule?.timezone ?? TimeZone.ETC_UTC,
      }),
      target: new targets.LambdaInvoke(runningScheduleFunctionAlias, {
        input: scheduler.ScheduleTargetInput.fromObject({
          Params: {
            TagKey: props.targetResource.tagKey,
            TagValues: props.targetResource.tagValues,
            Mode: 'Stop',
          },
        }),
      }),
    });

  }
}

