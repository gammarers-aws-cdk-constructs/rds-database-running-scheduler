# RDS Database Running Scheduler (CDK v2)

[![npm version](https://img.shields.io/npm/v/rds-database-running-scheduler?style=flat-square)](https://www.npmjs.com/package/rds-database-running-scheduler)
[![license](https://img.shields.io/npm/l/rds-database-running-scheduler?style=flat-square)](https://www.npmjs.com/package/rds-database-running-scheduler)
[![Node.js](https://img.shields.io/node/v/rds-database-running-scheduler?style=flat-square)](https://www.npmjs.com/package/rds-database-running-scheduler)
[![build](https://img.shields.io/github/actions/workflow/status/gammarers-aws-cdk-constructs/rds-database-running-scheduler/build.yml?label=build&style=flat-square)](https://github.com/gammarers-aws-cdk-constructs/rds-database-running-scheduler/actions/workflows/build.yml)

[![View on Construct Hub](https://constructs.dev/badge?package=rds-database-running-scheduler)](https://constructs.dev/packages/rds-database-running-scheduler)

This AWS CDK construct controls the start and stop of RDS DB instances and Aurora clusters based on resource tags. EventBridge Scheduler invokes a durable Lambda function on a cron schedule so databases run only during defined working hours.

## Features

- **Tag-based targeting**: Start and stop RDS DB instances and Aurora clusters that match a given tag key and values.
- **Multi-region discovery**: Searches every region enabled for the account, one region at a time, for tagged RDS resources. Set `targetRegions` to search only the regions you list.
- **Cluster-priority deduplication**: When tag discovery returns both an Aurora cluster and its member DB instances, only the cluster is processed to avoid conflicting start/stop operations.
- **Cross-region control**: Each resource is started and stopped in the region it lives in, even when that is not the stack's region.
- **EventBridge Scheduler**: Cron-based start and stop schedules with configurable timezone, time, and weekdays.
- **Lambda with Durable Execution**: A single durable run discovers resources by tag, starts or stops them, and waits until they reach the desired state or the per-resource wait limit.
- **Configurable wait**: Set `resourceWait.intervalSeconds` and `resourceWait.maxSeconds` to control how often each resource is checked and how long the function waits before timing out. Defaults are 60 seconds and 1800 seconds.
- **Optional Slack notifications**: Set `notification.slack.enable` to `SlackNotificationEnable.ENABLED` and provide `secretName` to post schedule progress and per-resource results to Slack via Secrets Manager. Leave `enable` unset (default `SlackNotificationEnable.DISABLED`), set it to `DISABLED`, or omit `notification.slack` to skip secret lookup, Slack API calls, and related IAM grants. When Slack is enabled, a timeout posts a message unless `notification.slack.notifyOnWaitTimeout` is `WaitTimeoutNotification.DISABLED`.
- **Opt-in failure detection**: Set `failureDetection.enabled` to `true` to create CloudWatch alarms for the Lambda `Errors` and `Throttles` metrics and for the handler's failure logs (wait timeout, unexpected status, failed execution). Pass an existing SNS topic as `failureDetection.alarmTopic` to be notified. Nothing is created by default, and the construct never creates an SNS topic.
- **Supported resources**: RDS DB instances and RDS Aurora clusters.

## How it works

EventBridge Scheduler runs a start cron and a stop cron. Each one invokes a durable Lambda function. A failed invocation is retried at most twice, and only while the original event is less than 2 hours old. That window matches the durable execution timeout and is not configurable via props today. On the default schedule it ends before the opposite cron, so a failed stop is not run again after the next start.

The function lists the regions enabled for the account and searches each one with the Resource Groups Tagging API for RDS DB instances and Aurora clusters that match `targetResource`. The Tagging API returns only the resources of the region it is called in, so each region is searched separately. When `targetRegions` is set, only those regions are searched. When both a cluster and its member instances match, only the cluster is controlled. Each remaining resource is started or stopped in the region taken from its ARN.

The function then checks that resource every `resourceWait.intervalSeconds` until it is available or stopped, or until `resourceWait.maxSeconds` elapses. A stop also waits through `storage-optimization`. A start that sees `storage-optimization` waits until the status is `stopped`, then starts the database. `configuring-iam-database-auth` and `configuring-log-exports` are waited on the same way. When Slack is enabled, it posts progress and, by default, a message when the wait limit is exceeded.

Some cases change nothing. When no resource matches, the run ends without posting to Slack. A resource that is already in the target state (available for a start, stopped for a stop) gets no start or stop call, but Slack still receives its result message. A cluster that no longer exists is skipped without a failure and without a result message. Both schedules can also be created in the disabled state with `enableScheduling`.

A resource that does not reach its target state within the wait limit, or reports a status that cannot be handled (for example `incompatible-restore`), fails the run. The other resources are still processed first, then the whole execution is marked as failed. The failure is also written to the log, which is what the opt-in failure detection alarms watch.

The Lambda log group keeps logs for three months. It is deleted only when its creation fails, and it is retained when the stack is deleted or the resource is replaced, so failures stay investigable.

## Installation

### npm

```bash
npm install rds-database-running-scheduler
```

### yarn

```bash
yarn add rds-database-running-scheduler
```

### pnpm

```bash
pnpm add rds-database-running-scheduler
```

## Usage

### Minimal deployable app

Use the **Stack** `RDSDatabaseRunningScheduleStack` when you want a dedicated stack you can deploy as-is. Put this in your CDK app entry (for example `bin/app.ts`).

```typescript
import { App } from 'aws-cdk-lib';
import { RDSDatabaseRunningScheduleStack } from 'rds-database-running-scheduler';

const app = new App();

new RDSDatabaseRunningScheduleStack(app, 'RDSDatabaseRunningScheduleStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  targetResource: { tagKey: 'WorkHoursRunning', tagValues: ['YES'] },
});

app.synth();
```

This uses the default schedules: start at 07:50 UTC and stop at 19:05 UTC, Monday–Friday. Slack notifications and failure detection are off. Every region enabled for the account is searched.

Deploy checklist:

1. Install this package and its peers (`aws-cdk-lib`, `constructs`, `lambda-failure-detector`) in your CDK app.
2. Tag the RDS DB instances or Aurora clusters you want to control with the same `tagKey` and one of the `tagValues`.
3. Only when you enable Slack, create the Secrets Manager secret first (see [Slack secret](#slack-secret)).
4. From the CDK app: `npx cdk deploy RDSDatabaseRunningScheduleStack`

### Construct

Use the **Construct** `RDSDatabaseRunningScheduler` when adding the scheduler into an existing Stack or any CDK scope. It accepts the same scheduler props as the Stack.

```typescript
import { RDSDatabaseRunningScheduler } from 'rds-database-running-scheduler';

new RDSDatabaseRunningScheduler(scope, 'RDSDatabaseRunningScheduler', {
  targetResource: { tagKey: 'WorkHoursRunning', tagValues: ['YES'] },
});
```

To search only some regions, list them in `targetRegions`:

```typescript
new RDSDatabaseRunningScheduler(scope, 'RDSDatabaseRunningScheduler', {
  targetResource: { tagKey: 'WorkHoursRunning', tagValues: ['YES'] },
  targetRegions: ['ap-northeast-1', 'us-east-1'],
});
```

To be alerted when a run fails, enable failure detection and pass an SNS topic you already own:

```typescript
import { Topic } from 'aws-cdk-lib/aws-sns';

new RDSDatabaseRunningScheduler(scope, 'RDSDatabaseRunningScheduler', {
  targetResource: { tagKey: 'WorkHoursRunning', tagValues: ['YES'] },
  failureDetection: {
    enabled: true,
    alarmTopic: Topic.fromTopicArn(scope, 'AlarmTopic', 'arn:aws:sns:ap-northeast-1:123456789012:alarm-topic'),
  },
});
```

With Slack notifications and a custom schedule:

```typescript
import { TimeZone } from 'aws-cdk-lib';
import { RDSDatabaseRunningScheduler, SchedulingEnable, SlackNotificationEnable } from 'rds-database-running-scheduler';

new RDSDatabaseRunningScheduler(scope, 'RDSDatabaseRunningScheduler', {
  targetResource: { tagKey: 'WorkHoursRunning', tagValues: ['YES'] },
  notification: { slack: { enable: SlackNotificationEnable.ENABLED, secretName: 'example/slack/webhook' } },
  enableScheduling: SchedulingEnable.ENABLED,
  startSchedule: { timezone: TimeZone.ASIA_TOKYO, minute: '50', hour: '7', week: 'MON-FRI' },
  stopSchedule: { timezone: TimeZone.ASIA_TOKYO, minute: '5', hour: '19', week: 'MON-FRI' },
});
```

The Stack takes the same props, so the same options work with `RDSDatabaseRunningScheduleStack`.

For Aurora, tagging the cluster is sufficient. If member DB instances inherit the same tag, the Lambda automatically excludes them when the parent cluster is also targeted, so cluster-level start/stop is applied once without conflicting instance-level operations.

### Slack secret

Slack is optional. Only when `notification.slack.enable` is `SlackNotificationEnable.ENABLED` do you need to create the secret in AWS Secrets Manager **before deploying**. Without it, no secret is read and no secret-related IAM is granted. When enabled, the construct grants the Lambda read access to that secret and attaches the AWS Parameters and Secrets Lambda Extension layer, so you do not add either yourself. The secret must contain JSON with `token` and `channel` fields:

```json
{
  "token": "xoxb-...",
  "channel": "C0123456789"
}
```

## Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `targetResource` | `TargetResource` | Yes | Tag key and values used to select RDS resources. |
| `targetRegions` | `string[]` | No | Regions to search for tagged RDS resources. Each must be a region enabled for the account. Must not be empty, blank, or contain duplicates. Default: every region enabled for the account. |
| `notification` | `Notification` | No | Notification channels. Set `notification.slack.enable` to `SlackNotificationEnable.ENABLED` to send Slack messages. |
| `resourceWait` | `ResourceWait` | No | Per-resource status-check interval and maximum wait. Default: 60-second interval, 1800-second maximum. |
| `enableScheduling` | `SchedulingEnable` | No | Whether start and stop schedules are enabled. `ENABLED` or `DISABLED`. Default: `ENABLED`. |
| `startSchedule` | `Schedule` | No | Start schedule. Default: 07:50 UTC, MON–FRI. |
| `stopSchedule` | `Schedule` | No | Stop schedule. Default: 19:05 UTC, MON–FRI. |
| `failureDetection` | `LambdaFailureDetection` | No | Opt-in CloudWatch failure detection from [lambda-failure-detector](https://www.npmjs.com/package/lambda-failure-detector). Alarms are created only when `enabled` is `true`. `alarmTopic` is an optional existing SNS topic for every alarm. Default: no failure detection resources. |

### Schedule

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `timezone` | `TimeZone` | Yes | CDK timezone constant (for example `TimeZone.ASIA_TOKYO`, `TimeZone.ETC_UTC`). |
| `minute` | `string` | No | Cron minute (for example `'50'`). |
| `hour` | `string` | No | Cron hour (for example `'7'`, `'19'`). |
| `week` | `string` | No | Cron week day (for example `'MON-FRI'`). |

### TargetResource

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tagKey` | `string` | Yes | Tag key to filter RDS resources. |
| `tagValues` | `string[]` | Yes | Tag values to match (resources with any of these values are targeted). |

### Notification

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `slack` | `SlackNotification` | No | Slack settings. Omit, or set `enable` to `SlackNotificationEnable.DISABLED`, to disable Slack. |

### SlackNotification

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `enable` | `SlackNotificationEnable` | No | Enable Slack notifications. `ENABLED` or `DISABLED`. Default: `DISABLED`. When `DISABLED`, secret lookup, Slack API calls, and IAM grants are skipped. |
| `secretName` | `string` | No | Secrets Manager secret name containing Slack `token` and `channel`. Required when `enable` is `ENABLED`. |
| `notifyOnWaitTimeout` | `WaitTimeoutNotification` | No | Post a Slack message when a resource exceeds `resourceWait.maxSeconds`. `ENABLED` or `DISABLED`. Applies only when `enable` is `ENABLED`. Default: `ENABLED`. |

### ResourceWait

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `intervalSeconds` | `number` | No | Seconds between status checks. Positive integer. Default: `60`. |
| `maxSeconds` | `number` | No | Maximum accumulated wait seconds for one resource. Positive integer, greater than or equal to `intervalSeconds`, and at most `6900`. Default: `1800`. |

## API

See [API.md](./API.md).

## Requirements

- **Node.js**: >= 20.0.0
- **AWS CDK**: ^2.232.0
- **constructs**: ^10.5.1
- **lambda-failure-detector**: ^0.2.1 (peer dependency, used only when `failureDetection.enabled` is `true`)
- **AWS**: Account and region with permissions to create EventBridge Scheduler, Lambda, IAM, and CloudWatch Logs; RDS describe/start/stop permissions for targeted resources. Start/stop IAM is scoped to DB instance and cluster ARNs in the account and to `aws:ResourceTag` matching `targetResource`. Resource Groups Tagging API access (`tag:GetResources`) and `ec2:DescribeRegions` are required for resource discovery. Secrets Manager access is required only when Slack notifications are enabled.

## Notes

- **Least privilege**: Discovery and status checks (`tag:GetResources`, `ec2:DescribeRegions`, `rds:DescribeDBInstances`, `rds:DescribeDBClusters`) do not support resource-level permissions, so they use `*`. Start and stop are limited to DB instance and cluster ARNs in your account and to resources whose `aws:ResourceTag/<tagKey>` matches `targetResource`. The region part of those ARNs is `*` because tagged resources may live outside the stack region.
- **Safe to run again**: A start on an available resource and a stop on a stopped resource make no RDS call, so a retried or repeated run does not repeat a finished operation.
- **Retries**: Failed invocations are retried at most twice within 2 hours, which is not configurable via props today. A run that fails because a resource timed out or reported an unexpected status is a failed invocation too.

## Troubleshooting

Start with the Lambda log group (`/aws/lambda/<function name>`). It keeps logs for three months and is retained when the stack is deleted.

When nothing seems to happen, check these in order:

1. The schedules were not created with `enableScheduling: SchedulingEnable.DISABLED`.
2. The resources carry the exact `tagKey` and one of the `tagValues`.
3. The resources are in a searched region: every enabled region by default, or only `targetRegions` when it is set.
4. The resource is not a cluster that no longer exists, which is skipped silently.

When Slack messages are missing, confirm the secret exists, contains `token` and `channel`, and that `notification.slack.enable` is `ENABLED`. A secret that cannot be read fails the run.

When `failureDetection.enabled` is `true`, these alarms are created. Each one counts ERROR logs that start with the marker of the same name, in the `RDSDatabaseRunningScheduler` metric namespace:

| Alarm / marker | Meaning |
|----------------|---------|
| `ResourceWaitTimedOut` | A resource did not reach its target state within `resourceWait.maxSeconds`. |
| `ResourceStatusUnexpected` | A resource reported a status that cannot be handled, for example `incompatible-restore`. |
| `ScheduleExecutionFailed` | The whole execution failed for any reason, including the two above. It also fires for failures before any resource is processed, such as an invalid `targetRegions`. |

The Lambda `Errors` and `Throttles` alarms cover failures of the invocation itself. A durable execution that fails inside the handler does not always raise `Errors`, so rely on `ScheduleExecutionFailed` for those.

## License

This project is licensed under the (Apache-2.0) License.
