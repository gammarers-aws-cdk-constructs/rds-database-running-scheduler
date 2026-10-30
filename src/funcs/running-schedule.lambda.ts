import {
  type DurableContext,
  withDurableExecution,
} from '@aws/durable-execution-sdk-js';
import {
  DescribeRegionsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  RDSClient,
  StartDBClusterCommand,
  StartDBInstanceCommand,
  StopDBClusterCommand,
  StopDBInstanceCommand,
} from '@aws-sdk/client-rds';
import {
  GetResourcesCommand,
  type ResourceTagMapping,
  ResourceGroupsTaggingAPIClient,
} from '@aws-sdk/client-resource-groups-tagging-api';
import { WebClient } from '@slack/web-api';
import { secretFetcher } from 'aws-lambda-secret-fetcher';
import { StrictEnvResolver, StrictEnvType } from 'strict-env-resolver';
import {
  DEFAULT_MAX_WAIT_SECONDS,
  DEFAULT_WAIT_INTERVAL_SECONDS,
  LOG_MARKER_RESOURCE_STATUS_UNEXPECTED,
  LOG_MARKER_RESOURCE_WAIT_TIMED_OUT,
  LOG_MARKER_SCHEDULE_EXECUTION_FAILED,
  RUNNING_MODE_START,
  type RunningMode,
} from '../settings/consts';
import {
  nextPaginationToken,
  parseTargetRegions,
  selectTargetRegions,
} from './core/running-schedule-discovery';
import {
  RdsDatabaseRunningSchedulerStatusError,
  RdsDatabaseRunningSchedulerTimeoutError,
  RdsDatabaseRunningSchedulerValidateError,
} from './core/running-schedule-errors';
import {
  collectClusterKeysFromArns,
  filterClusterMemberDbs,
  parseRdsArn,
} from './core/running-schedule-targets';
import {
  nextWaitStep,
  RESOURCE_STATUS,
  resolveResourceWait,
  shouldContinueWaitLoop,
  type ResolvedResourceWait,
  type WaitLoopSignal,
} from './core/running-schedule-wait';

/**
 * Canonical status labels and emojis used in Slack notifications.
 */
const STATE_LIST = [
  { name: 'AVAILABLE', emoji: '🤩', state: RESOURCE_STATUS.AVAILABLE },
  { name: 'STOPPED', emoji: '😴', state: RESOURCE_STATUS.STOPPED },
] as const;

/**
 * Most resources processed at the same time in one run.
 */
const MAX_CONCURRENT_RESOURCES = 10;

/**
 * Shared HTTP settings for every AWS SDK client in this handler.
 *
 * Retries stay with the SDK defaults. These limits keep one hung request from
 * holding the invocation until the Lambda timeout.
 */
const AWS_CLIENT_CONFIG = {
  requestHandler: {
    connectionTimeout: 5_000,
    requestTimeout: 30_000,
  },
} as const;

/**
 * Event payload for scheduled start/stop execution.
 */
interface ScheduleEvent {
  /** Scheduler input parameters. */
  Params: {
    /** Tag key used to discover RDS resources. */
    TagKey: string;
    /** Tag values matched by the resource discovery query. */
    TagValues: string[];
    /** Requested operation: start or stop the matched resources. */
    Mode: RunningMode;
  };
}

/**
 * Secret shape stored in AWS Secrets Manager for Slack Web API access.
 * Expected JSON fields: `token` and `channel`.
 */
interface SlackSecret {
  /** Slack bot or user OAuth token. */
  token: string;
  /** Slack channel ID or name for notifications. */
  channel: string;
}

/**
 * Processing result for a single deduplicated RDS resource.
 */
interface ProcessingResult {
  /** Full ARN of the processed RDS resource. */
  resource: string;
  /** Final RDS status, or `skipped` when the resource was not found. */
  status: string;
  /** AWS account ID of the resource. */
  account: string;
  /** AWS region of the resource. */
  region: string;
  /** DB instance or cluster identifier. */
  identifier: string;
  /** Resource kind: standalone DB instance or cluster. */
  type: 'db' | 'cluster';
}

/**
 * In-memory cache of RDS clients keyed by AWS region for the current invocation.
 *
 * Ensures cross-region resources are targeted with the correct regional endpoint
 * while reusing clients when multiple resources share the same region.
 */
const rdsClientCache = new Map<string, RDSClient>();

/**
 * Returns an RDS client configured for the given region.
 * Clients are cached and reused when multiple resources share the same region.
 *
 * @param region AWS region extracted from the target resource ARN.
 * @returns Cached or newly created RDS client for the region.
 * @throws {RdsDatabaseRunningSchedulerValidateError} When `region` is empty.
 */
const getRdsClient = (region: string): RDSClient => {
  if (!region) {
    throw new RdsDatabaseRunningSchedulerValidateError('Region is required to create RDS client');
  }
  const cached = rdsClientCache.get(region);
  if (cached) {
    return cached;
  }
  const client = new RDSClient({ ...AWS_CLIENT_CONFIG, region });
  rdsClientCache.set(region, client);
  return client;
};

/**
 * Deduplicates discovered RDS ARNs by excluding cluster member DB instances when
 * their parent cluster is also present in the list.
 *
 * Cluster-level start/stop takes priority to avoid conflicting operations on
 * Aurora resources returned by both `rds:cluster` and `rds:db` type filters.
 *
 * @param arns RDS resource ARNs returned by the Resource Groups Tagging API.
 * @returns Deduplicated ARNs ready for start/stop processing.
 * @throws {Error} When `DescribeDBInstances` fails for a targeted DB instance.
 */
const deduplicateTargetResources = async (arns: string[]): Promise<string[]> => {
  const clusterKeys = collectClusterKeysFromArns(arns);
  if (clusterKeys.size === 0) {
    return arns;
  }

  const dbClusterIdentifiers = new Map<string, string | undefined>();
  for (const arn of arns) {
    const info = parseRdsArn(arn);
    if (info.type !== 'db') {
      continue;
    }
    const rds = getRdsClient(info.region);
    const response = await rds.send(
      new DescribeDBInstancesCommand({ DBInstanceIdentifier: info.identifier }),
    );
    dbClusterIdentifiers.set(arn, response.DBInstances?.[0]?.DBClusterIdentifier);
  }

  return filterClusterMemberDbs(arns, dbClusterIdentifiers, clusterKeys);
};

/**
 * Lists the regions enabled for the account.
 *
 * `DescribeRegions` returns only enabled regions by default, so regions that
 * need an opt-in are included only after the account has opted in.
 *
 * @returns Enabled region names.
 */
const listEnabledRegions = async (): Promise<string[]> => {
  const client = new EC2Client({ ...AWS_CLIENT_CONFIG });
  const response = await client.send(new DescribeRegionsCommand({}));
  return (response.Regions ?? []).map((r) => r.RegionName ?? '').filter(Boolean);
};

/**
 * Finds RDS DB instance and cluster ARNs that carry the target tag in one region.
 *
 * The Resource Groups Tagging API returns only resources in the region of the
 * client, so each region needs its own client. All result pages are read.
 *
 * @param region AWS region to search.
 * @param tagKey Tag key to match.
 * @param tagValues Tag values to match.
 * @returns RDS resource ARNs found in the region.
 */
const findTaggedResourceArns = async (
  region: string,
  tagKey: string,
  tagValues: string[],
): Promise<string[]> => {
  const client = new ResourceGroupsTaggingAPIClient({ ...AWS_CLIENT_CONFIG, region });
  const arns: string[] = [];
  let paginationToken: string | undefined;
  do {
    const response = await client.send(
      new GetResourcesCommand({
        ResourceTypeFilters: ['rds:db', 'rds:cluster'],
        TagFilters: [{ Key: tagKey, Values: tagValues }],
        PaginationToken: paginationToken,
      }),
    );
    arns.push(...(response.ResourceTagMappingList ?? []).map((m: ResourceTagMapping) => m.ResourceARN ?? '').filter(Boolean));
    paginationToken = nextPaginationToken(response.PaginationToken);
  } while (paginationToken !== undefined);
  return arns;
};

/**
 * Converts a raw RDS status into a display-friendly label for Slack.
 *
 * @param current Current RDS status string.
 * @returns Emoji and name pair when a known status is found, otherwise `undefined`.
 */
const getStateDisplay = (current: string): { emoji: string; name: string } | undefined => {
  const found = STATE_LIST.find((s) => s.state === current);
  return found ? { emoji: found.emoji, name: found.name } : undefined;
};

/**
 * Reads an error name from an unknown thrown value.
 *
 * @param err Value caught from an AWS SDK call.
 * @returns The error name when it is a string, otherwise an empty string.
 */
const readErrorName = (err: unknown): string => {
  if (typeof err !== 'object' || err === null) {
    return '';
  }
  if (!('name' in err)) {
    return '';
  }
  if (typeof err.name !== 'string') {
    return '';
  }
  return err.name;
};

/**
 * Reads a log-friendly message from an unknown thrown value.
 *
 * @param err Value caught from a handler step.
 * @returns The error message, or the stringified value when it is not an `Error`.
 */
const readErrorMessage = (err: unknown): string => {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
};

/**
 * Slack settings for the wait-timeout notice of one resource.
 */
interface WaitTimeoutNotice {
  /** Slack client, when Slack is configured. */
  client: WebClient | undefined;
  /** Slack channel, when Slack is configured. */
  channel: string | undefined;
  /** Parent message timestamp the notice replies to. */
  threadTs: string | undefined;
  /** Whether `NOTIFY_SLACK_ON_WAIT_TIMEOUT` is on. */
  enabled: boolean;
  /** Maximum wait seconds reported in the notice. */
  maxSeconds: number;
}

/**
 * Logs a resource failure for the failure-detection alarms and, for a wait
 * timeout, posts the Slack timeout notice when it is enabled.
 *
 * The caller rethrows the original error after this returns.
 *
 * @param context Durable context of the failed resource.
 * @param err Error raised while processing the resource.
 * @param targetResource Target RDS resource ARN.
 * @param notice Slack settings for the timeout notice.
 */
const reportResourceFailure = async (
  context: DurableContext,
  err: unknown,
  targetResource: string,
  notice: WaitTimeoutNotice,
): Promise<void> => {
  if (err instanceof RdsDatabaseRunningSchedulerStatusError) {
    context.logger.error(`${LOG_MARKER_RESOURCE_STATUS_UNEXPECTED}: ${err.message}`);
    return;
  }
  if (!(err instanceof RdsDatabaseRunningSchedulerTimeoutError)) {
    return;
  }
  context.logger.error(`${LOG_MARKER_RESOURCE_WAIT_TIMED_OUT}: ${err.message}`);
  const { client, channel } = notice;
  if (!client || !channel || !notice.enabled) {
    return;
  }
  const target = parseRdsArn(targetResource);
  await context.step('post-slack-timeout-message', async () => {
    return client.chat.postMessage({
      channel,
      thread_ts: notice.threadTs,
      attachments: [
        {
          color: '#e01e5a',
          pretext: `The RDS ${target.type} ${target.identifier}`
            + ' did not reach the target state within the wait limit.',
          fields: [
            { title: 'Account', value: target.account, short: true },
            { title: 'Region', value: target.region, short: true },
            { title: 'Type', value: target.type, short: true },
            { title: 'Identifier', value: target.identifier, short: true },
            { title: 'Status', value: 'TIMED_OUT', short: true },
            { title: 'Max wait (seconds)', value: String(notice.maxSeconds), short: true },
          ],
        },
      ],
    });
  });
};

/**
 * Processes one RDS resource until it reaches a stable state or the wait budget is spent.
 *
 * The function checks status, triggers start/stop when needed, and waits while
 * the resource is transitioning. That includes `storage-optimization` after a
 * stop, plus `configuring-iam-database-auth` and `configuring-log-exports`.
 * A start that sees `storage-optimization` waits until the status is `stopped`,
 * then starts the resource. Each wait uses `intervalSeconds`. Accumulated
 * waits stop at `maxSeconds`. Uses a region-specific RDS client derived from
 * the target ARN so resources outside the Lambda deployment region are handled
 * correctly.
 *
 * @param context Durable execution context.
 * @param targetResource Target RDS resource ARN after cluster-priority deduplication.
 * @param mode Requested operation mode.
 * @param waitSettings Validated interval and maximum wait for this resource.
 * @returns Final processing result including status and resource metadata.
 * @throws {RdsDatabaseRunningSchedulerStatusError} When the resource reaches an unexpected status.
 * @throws {RdsDatabaseRunningSchedulerTimeoutError} When the wait budget is exhausted.
 * @throws {Error} When a DB instance is not found.
 */
const processing = async (
  context: DurableContext,
  targetResource: string,
  mode: RunningMode,
  waitSettings: ResolvedResourceWait,
): Promise<ProcessingResult> => {
  const target = await context.step('get-identifier', async () => parseRdsArn(targetResource));

  const rds = getRdsClient(target.region);
  const { intervalSeconds, maxSeconds } = waitSettings;
  let iteration = 0;
  let elapsedWaitSeconds = 0;
  let signal: WaitLoopSignal = 'open';
  let outcome: ProcessingResult | undefined;

  const toResult = (status: string): ProcessingResult => ({
    resource: targetResource,
    status,
    account: target.account,
    region: target.region,
    identifier: target.identifier,
    type: target.type,
  });

  // Check status at least once. Continue only while the resource still needs a
  // start, stop, or transition wait and the budget covers another interval.
  do {
    const stepName = `describe-${target.type}-${target.identifier}-${iteration}`;
    const statusResult = await context.step(stepName, async () => {
      if (target.type === 'db') {
        const res = await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: target.identifier }));
        const current = res.DBInstances?.[0]?.DBInstanceStatus;
        if (current == null) {
          throw new Error(`DB instance not found: ${target.identifier}`);
        }
        return { current, type: target.type, identifier: target.identifier };
      }
      try {
        const res = await rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: target.identifier }));
        const current = res.DBClusters?.[0]?.Status;
        if (current == null) {
          return { current: RESOURCE_STATUS.NOT_FOUND, type: target.type, identifier: target.identifier };
        }
        return { current, type: target.type, identifier: target.identifier };
      } catch (err: unknown) {
        const code = readErrorName(err);
        if (code === 'DBClusterNotFoundFault' || code === 'DbClusterNotFoundException') {
          return { current: RESOURCE_STATUS.NOT_FOUND, type: target.type, identifier: target.identifier };
        }
        throw err;
      }
    });

    const step = nextWaitStep({
      mode,
      current: statusResult.current,
      elapsedWaitSeconds,
      intervalSeconds,
      maxWaitSeconds: maxSeconds,
      resourceLabel: `type=${target.type} identifier=${target.identifier}`,
    });

    if (step.kind === 'finish') {
      signal = 'settled';
      outcome = toResult(step.status);
    }
    // Step and wait names carry the iteration so each attempt stays unique across replays.
    if (step.kind === 'pause' && step.command === 'start' && target.type === 'db') {
      await context.step(`start-db-${target.identifier}-${iteration}`, async () => {
        await rds.send(new StartDBInstanceCommand({ DBInstanceIdentifier: target.identifier }));
      });
    }
    if (step.kind === 'pause' && step.command === 'start' && target.type === 'cluster') {
      await context.step(`start-cluster-${target.identifier}-${iteration}`, async () => {
        await rds.send(new StartDBClusterCommand({ DBClusterIdentifier: target.identifier }));
      });
    }
    if (step.kind === 'pause' && step.command === 'stop' && target.type === 'db') {
      await context.step(`stop-db-${target.identifier}-${iteration}`, async () => {
        await rds.send(new StopDBInstanceCommand({ DBInstanceIdentifier: target.identifier }));
      });
    }
    if (step.kind === 'pause' && step.command === 'stop' && target.type === 'cluster') {
      await context.step(`stop-cluster-${target.identifier}-${iteration}`, async () => {
        await rds.send(new StopDBClusterCommand({ DBClusterIdentifier: target.identifier }));
      });
    }
    if (step.kind === 'pause') {
      await context.wait(`wait-${target.type}-${target.identifier}-${iteration}`, { seconds: intervalSeconds });
      elapsedWaitSeconds += intervalSeconds;
    }

    iteration += 1;
  } while (shouldContinueWaitLoop(signal));

  if (outcome === undefined) {
    throw new Error(`wait loop ended without a result: type=${target.type} identifier=${target.identifier}`);
  }
  return outcome;
};

/**
 * Scheduled Lambda handler that discovers tagged RDS resources in every enabled
 * region of the account (or only in `TARGET_REGIONS`), deduplicates Aurora
 * cluster members in favor of cluster-level control, applies start/stop actions
 * with per-ARN region RDS clients, and optionally posts progress/results to Slack.
 *
 * Resource discovery lists the enabled regions with `DescribeRegions`, then
 * searches each region with its own `ResourceGroupsTaggingAPIClient`, because
 * the Resource Groups Tagging API returns only resources in the region of the
 * client. `TARGET_REGIONS` (a JSON array, default `[]`) narrows the search; an
 * empty array searches every enabled region. When both a cluster and its member
 * DB instances match the tag filter, only the cluster ARN is processed.
 * RDS API calls use the region embedded in each ARN.
 *
 * When `SLACK_SECRET_NAME` is set (by the CDK construct when `notification.slack.enable`
 * is `true`), fetches the Slack secret through the AWS Parameters and Secrets Lambda
 * Extension (`aws-lambda-secret-fetcher`) and posts progress/results. When unset or empty,
 * Slack notification steps are skipped. Requires a Lambda runtime with
 * `AWS_SESSION_TOKEN` and the Params and Secrets extension layer (attached by the
 * construct when Slack is enabled).
 *
 * `WAIT_INTERVAL_SECONDS` and `MAX_WAIT_SECONDS` control the per-resource status
 * check. When a resource exceeds the maximum, the handler posts a Slack timeout
 * message only when Slack is configured and `NOTIFY_SLACK_ON_WAIT_TIMEOUT` is true,
 * then fails that resource.
 *
 * @param event Scheduler event payload containing tag filters and operation mode.
 * @param context Durable execution context from the durable execution SDK.
 * @returns Processed resource count and per-resource results after deduplication.
 * @throws {RdsDatabaseRunningSchedulerValidateError} When required event parameters
 * (`Params.TagKey`, `Params.TagValues`, `Params.Mode`) are missing, when wait
 * settings are not positive integers within the allowed maximum, when
 * `TARGET_REGIONS` is not a JSON array of distinct region names, or when it names
 * a region that is not enabled for the account.
 * @throws {RdsDatabaseRunningSchedulerTimeoutError} When a resource exceeds its wait budget.
 * @throws {Error} When Slack is enabled but `AWS_SESSION_TOKEN` is missing/blank, or secret fetch fails.
 */
const runSchedule = async (event: ScheduleEvent, context: DurableContext) => {
  const params = event.Params;
  if (!params?.TagKey || !params?.TagValues || !params?.Mode) {
    throw new RdsDatabaseRunningSchedulerValidateError(
      'Invalid event: Params.TagKey, Params.TagValues, Params.Mode are required.',
    );
  }

  const resourceWait = resolveResourceWait(
    StrictEnvResolver.resolve('WAIT_INTERVAL_SECONDS', StrictEnvType.Number, { default: DEFAULT_WAIT_INTERVAL_SECONDS }),
    StrictEnvResolver.resolve('MAX_WAIT_SECONDS', StrictEnvType.Number, { default: DEFAULT_MAX_WAIT_SECONDS }),
  );
  const notifySlackOnWaitTimeout = StrictEnvResolver.resolve(
    'NOTIFY_SLACK_ON_WAIT_TIMEOUT',
    StrictEnvType.Boolean,
    { default: false },
  );
  const slackSecretName = StrictEnvResolver.resolve('SLACK_SECRET_NAME', StrictEnvType.String, { default: '' });
  const requestedRegions = parseTargetRegions(
    StrictEnvResolver.resolve('TARGET_REGIONS', StrictEnvType.String, { default: '[]' }),
  );

  let slackClient: WebClient | undefined;
  let slackChannel: string | undefined;
  if (slackSecretName) {
    const slackSecretValue = await context.step('fetch-slack-secret', async () => {
      return secretFetcher.getSecretValue<SlackSecret>(slackSecretName);
    });
    slackClient = new WebClient(slackSecretValue.token);
    slackChannel = slackSecretValue.channel;
  }

  // Search every enabled region, or only the regions named by `targetRegions`.
  const searchRegions = await context.step('get-target-regions', async () => {
    return selectTargetRegions(await listEnabledRegions(), requestedRegions);
  });

  const discoveredResources: string[] = [];
  for (const region of searchRegions) {
    const arns = await context.step(`get-resources-${region}`, async () => {
      return findTaggedResourceArns(region, params.TagKey, params.TagValues);
    });
    discoveredResources.push(...arns);
  }

  const targetResources = await context.step('deduplicate-target-resources', async () => {
    return deduplicateTargetResources(discoveredResources);
  });

  if (targetResources.length === 0) {
    return { processed: 0, results: [] };
  }

  let slackParentMessageTs: string | undefined;
  if (slackClient && slackChannel) {
    const client = slackClient;
    const channel = slackChannel;
    const slackParentMessageResult = await context.step('post-slack-messages', async () => {
      return client.chat.postMessage({
        channel,
        text: `${params.Mode === RUNNING_MODE_START ? '😆 Starts' : '🥱 Stops'} the scheduled RDS Database or Cluster.`,
      });
    });
    slackParentMessageTs = slackParentMessageResult?.ts;
  }

  const results = await context.map(
    targetResources,
    async (ctx: DurableContext, targetResource: string, index: number) => {
      return ctx.runInChildContext(`resource-${index}`, async (childCtx: DurableContext) => {
        let result: ProcessingResult;
        try {
          result = await processing(childCtx, targetResource, params.Mode, resourceWait);
        } catch (err: unknown) {
          await reportResourceFailure(childCtx, err, targetResource, {
            client: slackClient,
            channel: slackChannel,
            threadTs: slackParentMessageTs,
            enabled: notifySlackOnWaitTimeout,
            maxSeconds: resourceWait.maxSeconds,
          });
          throw err;
        }
        if (result.status === 'skipped') {
          return result;
        }
        if (!slackClient || !slackChannel) {
          return result;
        }
        const client = slackClient;
        const channel = slackChannel;
        await childCtx.step('post-slack-child-messages', async () => {
          const display = getStateDisplay(result.status);

          return client.chat.postMessage({
            channel,
            thread_ts: slackParentMessageTs,
            attachments: [
              {
                color: '#36a64f',
                pretext: `${display?.emoji} The status of the RDS ${result.type}`
                  + ` changed to ${display?.name} due to the schedule.`,
                fields: [
                  { title: 'Account', value: result.account, short: true },
                  { title: 'Region', value: result.region, short: true },
                  { title: 'Type', value: result.type, short: true },
                  { title: 'Identifier', value: result.identifier, short: true },
                  { title: 'Status', value: (display?.name ?? 'Unknown'), short: true },
                ],
              },
            ],
          });
        });
        return result;
      });
    },
    { maxConcurrency: MAX_CONCURRENT_RESOURCES },
  );

  // `context.map` records each failed resource instead of throwing, so rethrow
  // the first failure to fail the execution after every resource was attempted.
  results.throwIfError();

  return { processed: results.totalCount, results: results.getResults() };
};

/**
 * Durable Lambda handler for the scheduled start/stop run.
 *
 * Writes one ERROR log that starts with `LOG_MARKER_SCHEDULE_EXECUTION_FAILED` when
 * the execution fails for any reason, then rethrows the original error.
 *
 * @param event Scheduler event payload containing tag filters and operation mode.
 * @param context Durable execution context from the durable execution SDK.
 * @returns Processed resource count and per-resource results after deduplication.
 * @throws Any error raised by {@link runSchedule}.
 */
export const handler = withDurableExecution(
  async (event: ScheduleEvent, context: DurableContext) => {
    try {
      return await runSchedule(event, context);
    } catch (err: unknown) {
      context.logger.error(`${LOG_MARKER_SCHEDULE_EXECUTION_FAILED}: ${readErrorMessage(err)}`);
      throw err;
    }
  },
);
