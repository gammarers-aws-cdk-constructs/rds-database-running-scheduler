import { Aws, Duration, RemovalPolicy, TimeZone } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as targets from 'aws-cdk-lib/aws-scheduler-targets';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import {
  DEFAULT_MAX_WAIT_SECONDS,
  DEFAULT_WAIT_INTERVAL_SECONDS,
  resolveResourceWait,
} from './core/resource-wait';
import { RunningScheduleFunction } from './funcs/running-schedule-function';

/**
 * Whether Slack notifications are sent.
 */
export enum SlackNotificationEnable {
  /** Send Slack messages. */
  ENABLED = 'enabled',
  /** Skip secret lookup, Slack API calls, and related IAM grants. */
  DISABLED = 'disabled',
}

/**
 * Whether the start and stop schedules are active.
 */
export enum SchedulingEnable {
  /** Create the schedules in the enabled state. */
  ENABLED = 'enabled',
  /** Create the schedules in the disabled state. */
  DISABLED = 'disabled',
}

/**
 * Whether to post a Slack message when a resource exceeds its wait limit.
 */
export enum WaitTimeoutNotification {
  /** Post a Slack message when the per-resource wait limit is exceeded. */
  ENABLED = 'enabled',
  /** Do not post a Slack message when the per-resource wait limit is exceeded. */
  DISABLED = 'disabled',
}

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
 * Notifications are off unless `enable` is {@link SlackNotificationEnable.ENABLED}.
 */
export interface SlackNotification {
  /**
   * Whether Slack notifications are enabled.
   * When {@link SlackNotificationEnable.DISABLED}, Secrets Manager lookup, Slack API calls, and related IAM grants are skipped.
   * @default SlackNotificationEnable.DISABLED
   */
  readonly enable?: SlackNotificationEnable;
  /**
   * Name of the Slack API secret in AWS Secrets Manager (`token` and `channel`).
   * Required when `enable` is {@link SlackNotificationEnable.ENABLED}.
   */
  readonly secretName?: string;
  /**
   * Whether to post a Slack message when a resource exceeds `resourceWait.maxSeconds`.
   * Applies only when `enable` is {@link SlackNotificationEnable.ENABLED}.
   * @default WaitTimeoutNotification.ENABLED
   */
  readonly notifyOnWaitTimeout?: WaitTimeoutNotification;
}

/**
 * Notification channel configuration for the scheduler workflow.
 * Omit a channel (or the whole object) to disable that channel.
 * Additional channels can be added here in the future without changing top-level props.
 */
export interface Notification {
  /** Optional Slack notification settings. Set `slack.enable` to {@link SlackNotificationEnable.ENABLED} to send messages. */
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
  /**
   * Enables or disables both start and stop schedules.
   * @default SchedulingEnable.ENABLED
   */
  readonly enableScheduling?: SchedulingEnable;
  /**
   * Optional notification channels.
   * Set `notification.slack.enable` to {@link SlackNotificationEnable.ENABLED} and provide `secretName` to send Slack messages.
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
 * Slack settings after applying defaults.
 * `ENABLED` includes the secret name and the timeout-notification choice.
 */
type ResolvedSlackNotification =
  | {
    readonly state: SlackNotificationEnable.ENABLED;
    readonly secretName: string;
    readonly notifyOnWaitTimeout: WaitTimeoutNotification;
  }
  | {
    readonly state: SlackNotificationEnable.DISABLED;
  };

/**
 * Resolves whether Slack notifications are enabled and which secret to use.
 *
 * @param slack Slack channel settings from construct props.
 * @returns Enabled state with a secret name, or a disabled state.
 * @throws {Error} When `slack.enable` is {@link SlackNotificationEnable.ENABLED} but `slack.secretName` is missing.
 */
const resolveSlackNotification = (
  slack: SlackNotification | undefined,
): ResolvedSlackNotification => {
  if (!slack) {
    return { state: SlackNotificationEnable.DISABLED };
  }
  if (slack.enable !== SlackNotificationEnable.ENABLED) {
    return { state: SlackNotificationEnable.DISABLED };
  }
  if (!slack.secretName) {
    throw new Error('notification.slack.secretName is required when notification.slack.enable is enabled');
  }
  return {
    state: SlackNotificationEnable.ENABLED,
    secretName: slack.secretName,
    notifyOnWaitTimeout: slack.notifyOnWaitTimeout ?? WaitTimeoutNotification.ENABLED,
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
    let notifySlackOnWaitTimeout = WaitTimeoutNotification.DISABLED;
    if (slackNotification.state === SlackNotificationEnable.ENABLED) {
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
        NOTIFY_SLACK_ON_WAIT_TIMEOUT: notifySlackOnWaitTimeout === WaitTimeoutNotification.ENABLED ? 'true' : 'false',
        ...(slackNotification.state === SlackNotificationEnable.ENABLED
          ? { SLACK_SECRET_NAME: slackNotification.secretName }
          : {}),
      },
      ...(slackNotification.state === SlackNotificationEnable.ENABLED
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
    if (slackNotification.state === SlackNotificationEnable.ENABLED) {
      const slackSecret = Secret.fromSecretNameV2(this, 'SlackSecret', slackNotification.secretName);
      slackSecret.grantRead(runningScheduleFunction);
    }

    // https://docs.aws.amazon.com/lambda/latest/dg/durable-getting-started-iac.html
    const runningScheduleFunctionAlias = runningScheduleFunction.addAlias('live');

    // Undefined keeps the schedules enabled. Only an explicit disabled value turns them off.
    const scheduleEnabled = props.enableScheduling !== SchedulingEnable.DISABLED;

    // Each schedule invokes the durable Lambda, which discovers tagged resources, starts or stops them, and waits for a stable state.
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

