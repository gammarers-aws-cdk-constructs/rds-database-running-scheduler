import {
  type DurableContext,
  withDurableExecution,
} from '@aws/durable-execution-sdk-js';
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
  collectClusterKeysFromArns,
  filterClusterMemberDbs,
  parseRdsArn,
} from './running-schedule-targets';

/**
 * Canonical status labels and emojis used in Slack notifications.
 */
const STATE_LIST = [
  { name: 'AVAILABLE', emoji: '🤩', state: 'available' },
  { name: 'STOPPED', emoji: '😴', state: 'stopped' },
] as const;

/**
 * RDS statuses that indicate an in-progress transition.
 */
const TRANSITIONING_STATES = [
  'starting',
  'configuring-enhanced-monitoring',
  'backing-up',
  'modifying',
  'stopping',
] as const;

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
    Mode: 'Start' | 'Stop';
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
 * @throws {Error} When `region` is empty.
 */
const getRdsClient = (region: string): RDSClient => {
  if (!region) {
    throw new Error('Region is required to create RDS client');
  }
  const cached = rdsClientCache.get(region);
  if (cached) {
    return cached;
  }
  const client = new RDSClient({ region });
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
 * Processes one RDS resource until it reaches a stable state.
 *
 * The function polls status, triggers start/stop when needed, and waits while
 * the resource is transitioning. Uses a region-specific RDS client derived
 * from the target ARN so resources outside the Lambda deployment region are
 * handled correctly.
 *
 * @param context Durable execution context.
 * @param targetResource Target RDS resource ARN after cluster-priority deduplication.
 * @param mode Requested operation mode.
 * @returns Final processing result including status and resource metadata.
 * @throws {Error} When the resource reaches an unexpected status or a DB instance is not found.
 */
const processing = async (
  context: DurableContext,
  targetResource: string,
  mode: 'Start' | 'Stop',
): Promise<ProcessingResult> => {
  const target = await context.step('get-identifier', async () => parseRdsArn(targetResource));

  const rds = getRdsClient(target.region);
  let iteration = 0;

  for (;;) {
    const stepName = `describe-${target.type}-${target.identifier}-${iteration}`;
    const statusResult = await context.step(stepName, async () => {
      if (target.type === 'db') {
        const res = await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: target.identifier }));
        const current = res.DBInstances?.[0]?.DBInstanceStatus;
        if (current == null) {
          throw new Error(`DB instance not found: ${target.identifier}`);
        }
        return { current, type: target.type as string, identifier: target.identifier };
      }
      try {
        const res = await rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: target.identifier }));
        const current = res.DBClusters?.[0]?.Status;
        if (current == null) {
          return { current: 'not-found', type: target.type as string, identifier: target.identifier };
        }
        return { current, type: target.type as string, identifier: target.identifier };
      } catch (err: unknown) {
        const code = err && typeof err === 'object' && 'name' in err ? (err as { name: string }).name : '';
        if (code === 'DBClusterNotFoundFault' || code === 'DbClusterNotFoundException') {
          return { current: 'not-found', type: target.type as string, identifier: target.identifier };
        }
        throw err;
      }
    });
    iteration += 1;

    if (statusResult.current === 'not-found') {
      return { resource: targetResource, status: 'skipped', account: target.account, region: target.region, identifier: target.identifier, type: target.type };
    }

    const current = statusResult.current;
    const isDb = target.type === 'db';
    const isCluster = target.type === 'cluster';

    const needStart = mode === 'Start' && current === 'stopped';
    const needStop = mode === 'Stop' && current === 'available';
    const alreadyDone =
      (mode === 'Start' && (current === 'available')) || (mode === 'Stop' && current === 'stopped');
    const isTransitioning = TRANSITIONING_STATES.includes(current as (typeof TRANSITIONING_STATES)[number]);

    if (needStart && isDb) {
      await context.step(`start-db-${target.identifier}`, async () => {
        await rds.send(new StartDBInstanceCommand({ DBInstanceIdentifier: target.identifier }));
      });
      await context.wait({ seconds: 60 });
      continue;
    }
    if (needStart && isCluster) {
      await context.step(`start-cluster-${target.identifier}`, async () => {
        await rds.send(new StartDBClusterCommand({ DBClusterIdentifier: target.identifier }));
      });
      await context.wait({ seconds: 60 });
      continue;
    }
    if (needStop && isDb) {
      await context.step(`stop-db-${target.identifier}`, async () => {
        await rds.send(new StopDBInstanceCommand({ DBInstanceIdentifier: target.identifier }));
      });
      await context.wait({ seconds: 60 });
      continue;
    }
    if (needStop && isCluster) {
      await context.step(`stop-cluster-${target.identifier}`, async () => {
        await rds.send(new StopDBClusterCommand({ DBClusterIdentifier: target.identifier }));
      });
      await context.wait({ seconds: 60 });
      continue;
    }
    if (alreadyDone) {
      return {
        resource: targetResource,
        status: current,
        account: target.account,
        region: target.region,
        identifier: target.identifier,
        type: target.type,
      };
    }
    if (isTransitioning) {
      await context.wait({ seconds: 60 });
      continue;
    }

    throw new Error(`db instance or cluster status fail: type=${target.type} identifier=${target.identifier} current=${current}`);
  }
};

/**
 * Scheduled Lambda handler that discovers tagged RDS resources account-wide,
 * deduplicates Aurora cluster members in favor of cluster-level control,
 * applies start/stop actions with per-ARN region RDS clients, and optionally
 * posts progress/results to Slack.
 *
 * Resource discovery uses the Lambda deployment region endpoint via
 * `ResourceGroupsTaggingAPIClient`; returned ARNs may refer to resources in
 * any region within the same account. When both a cluster and its member DB
 * instances match the tag filter, only the cluster ARN is processed.
 * RDS API calls use the region embedded in each ARN.
 *
 * When `SLACK_SECRET_NAME` is set (by the CDK construct via `notification.slack`),
 * fetches the Slack secret through the AWS Parameters and Secrets Lambda Extension
 * (`aws-lambda-secret-fetcher`) and posts progress/results. When unset or empty,
 * Slack notification steps are skipped. Requires a Lambda runtime with
 * `AWS_SESSION_TOKEN` and the Params and Secrets extension layer (attached by the
 * construct when Slack is enabled).
 *
 * @param event Scheduler event payload containing tag filters and operation mode.
 * @param context Durable execution context from the durable execution SDK.
 * @returns Processed resource count and per-resource results after deduplication.
 * @throws {Error} When required event parameters (`Params.TagKey`, `Params.TagValues`, `Params.Mode`) are missing.
 * @throws {Error} When Slack is enabled but `AWS_SESSION_TOKEN` is missing/blank, or secret fetch fails.
 */
export const handler = withDurableExecution(
  async (event: ScheduleEvent, context: DurableContext) => {
    const params = event.Params;
    if (!params?.TagKey || !params?.TagValues || !params?.Mode) {
      throw new Error('Invalid event: Params.TagKey, Params.TagValues, Params.Mode are required.');
    }

    const slackSecretName = StrictEnvResolver.resolve('SLACK_SECRET_NAME', StrictEnvType.String, { default: '' });

    let slackClient: WebClient | undefined;
    let slackChannel: string | undefined;
    if (slackSecretName) {
      const slackSecretValue = await context.step('fetch-slack-secret', async () => {
        return secretFetcher.getSecretValue<SlackSecret>(slackSecretName);
      });
      slackClient = new WebClient(slackSecretValue.token);
      slackChannel = slackSecretValue.channel;
    }

    const discoveredResources = await context.step('get-resources', async () => {
      const client = new ResourceGroupsTaggingAPIClient({});
      const response = await client.send(
        new GetResourcesCommand({
          ResourceTypeFilters: ['rds:db', 'rds:cluster'],
          TagFilters: [{ Key: params.TagKey, Values: params.TagValues }],
        }),
      );
      return (response.ResourceTagMappingList ?? []).map((m: ResourceTagMapping) => m.ResourceARN ?? '').filter(Boolean);
    });

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
          text: `${params.Mode === 'Start' ? '😆 Starts' : '🥱 Stops'} the scheduled RDS Database or Cluster.`,
        });
      });
      slackParentMessageTs = slackParentMessageResult?.ts;
    }

    const results = await context.map(
      targetResources,
      async (ctx: DurableContext, targetResource: string, index: number) => {
        return ctx.runInChildContext(`resource-${index}`, async (childCtx: DurableContext) => {
          const result = await processing(childCtx, targetResource, params.Mode);
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
                  pretext: `${display?.emoji} The status of the RDS ${result.type} changed to ${display?.name} due to the schedule.`,
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
      { maxConcurrency: 10 },
    );

    return { processed: results.totalCount, results: results.getResults() };
  },
);
