# RDS Database Running Scheduler (AWS CDK v2)

[![GitHub](https://img.shields.io/github/license/gammarers-aws-cdk-constructs/rds-database-running-scheduler?style=flat-square)](https://github.com/gammarers-aws-cdk-constructs/rds-database-running-scheduler/blob/main/LICENSE)
[![npm version](https://img.shields.io/npm/v/rds-database-running-scheduler?style=flat-square)](https://www.npmjs.com/package/rds-database-running-scheduler)
[![GitHub Workflow Status (branch)](https://img.shields.io/github/actions/workflow/status/gammarers-aws-cdk-constructs/rds-database-running-scheduler/release.yml?branch=main&label=release&style=flat-square)](https://github.com/gammarers-aws-cdk-constructs/rds-database-running-scheduler/actions/workflows/release.yml)
[![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/gammarers-aws-cdk-constructs/rds-database-running-scheduler?sort=semver&style=flat-square)](https://github.com/gammarers-aws-cdk-constructs/rds-database-running-scheduler/releases)

[![View on Construct Hub](https://constructs.dev/badge?package=rds-database-running-scheduler)](https://constructs.dev/packages/rds-database-running-scheduler)

This AWS CDK construct controls the start and stop of RDS DB instances and Aurora clusters based on resource tags. EventBridge Scheduler invokes a durable Lambda function on a cron schedule so databases run only during defined working hours. The Lambda discovers tagged resources account-wide via the Resource Groups Tagging API and controls each resource using the region encoded in its ARN. Default schedule: start 07:50 UTC, stop 19:05 UTC, Monday–Friday.

## Features

- **Tag-based targeting**: Start and stop RDS DB instances and Aurora clusters that match a given tag key and values.
- **Account-wide discovery**: Finds tagged RDS resources across all regions in the deployment account.
- **Region-aware RDS control**: Creates per-region RDS clients from each resource ARN so cross-region resources are handled correctly.
- **EventBridge Scheduler**: Cron-based start and stop schedules with configurable timezone, time, and weekdays.
- **Lambda with Durable Execution**: A single durable run discovers resources by tag, starts or stops them, and polls until they reach the desired state (with timeout).
- **Slack notifications**: Posts schedule progress and per-resource results to Slack using a secret stored in AWS Secrets Manager.
- **Supported resources**: RDS DB instances and RDS Aurora clusters.

## Installation

**npm**

```bash
npm install rds-database-running-scheduler
```

**yarn**

```bash
yarn add rds-database-running-scheduler
```

## Usage

Use the **Construct** `RDSDatabaseRunningScheduler` when adding the scheduler into an existing Stack or any CDK scope.

```typescript
import { TimeZone } from 'aws-cdk-lib';
import { RDSDatabaseRunningScheduler } from 'rds-database-running-scheduler';

new RDSDatabaseRunningScheduler(scope, 'RDSDatabaseRunningScheduler', {
  targetResource: { tagKey: 'WorkHoursRunning', tagValues: ['YES'] },
  secrets: { slackSecretName: 'example/slack/webhook' },
  enableScheduling: true,
  startSchedule: { timezone: TimeZone.ASIA_TOKYO, minute: '50', hour: '7', week: 'MON-FRI' },
  stopSchedule: { timezone: TimeZone.ASIA_TOKYO, minute: '5', hour: '19', week: 'MON-FRI' },
});
```

Use the **Stack** `RDSDatabaseRunningScheduleStack` when you want a dedicated Stack that only contains the scheduler. Both accept the same props.

```typescript
import { App, TimeZone } from 'aws-cdk-lib';
import { RDSDatabaseRunningScheduleStack } from 'rds-database-running-scheduler';

const app = new App();

new RDSDatabaseRunningScheduleStack(app, 'RDSDatabaseRunningScheduleStack', {
  targetResource: { tagKey: 'WorkHoursRunning', tagValues: ['YES'] },
  secrets: { slackSecretName: 'example/slack/webhook' },
  enableScheduling: true,
  startSchedule: { timezone: TimeZone.ASIA_TOKYO, minute: '50', hour: '7', week: 'MON-FRI' },
  stopSchedule: { timezone: TimeZone.ASIA_TOKYO, minute: '5', hour: '19', week: 'MON-FRI' },
});
```

Tag your RDS instances or Aurora clusters with the same `tagKey` and one of the `tagValues` so they are included in the schedule.

The Slack secret in AWS Secrets Manager must contain JSON with `token` and `channel` fields:

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
| `secrets` | `Secrets` | Yes | Slack configuration. `slackSecretName`: Secrets Manager secret name for Slack (`token` and `channel`). |
| `enableScheduling` | `boolean` | No | Whether schedules are enabled. Default: `true`. |
| `startSchedule` | `Schedule` | No | Start schedule. Default: 07:50 UTC, MON–FRI. |
| `stopSchedule` | `Schedule` | No | Stop schedule. Default: 19:05 UTC, MON–FRI. |

### Schedule

| Field | Type | Description |
|-------|------|-------------|
| `timezone` | `TimeZone` | CDK timezone constant (for example `TimeZone.ASIA_TOKYO`, `TimeZone.ETC_UTC`). |
| `minute` | `string` | Cron minute (for example `'50'`). |
| `hour` | `string` | Cron hour (for example `'7'`, `'19'`). |
| `week` | `string` | Cron week day (for example `'MON-FRI'`). |

### TargetResource

| Field | Type | Description |
|-------|------|-------------|
| `tagKey` | `string` | Tag key to filter RDS resources. |
| `tagValues` | `string[]` | Tag values to match (resources with any of these values are targeted). |

### Secrets

| Field | Type | Description |
|-------|------|-------------|
| `slackSecretName` | `string` | Secrets Manager secret name containing Slack `token` and `channel`. |

## Requirements

- **Node.js**: >= 20.0.0
- **AWS CDK**: ^2.232.0
- **constructs**: ^10.5.1
- **AWS**: Account and region with permissions to create EventBridge Scheduler, Lambda, IAM, CloudWatch Logs, and Secrets Manager; RDS start/stop permissions for targeted resources; Resource Groups Tagging API access for resource discovery.

## License

This project is licensed under the Apache-2.0 License.
