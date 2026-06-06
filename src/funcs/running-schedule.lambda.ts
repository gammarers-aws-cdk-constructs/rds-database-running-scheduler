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
import { SafeEnvGetter } from 'safe-env-getter';

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
 * Parsed metadata for an RDS resource ARN.
 */
interface TargetInfo {
  /** Full ARN of the target RDS resource. */
  targetResource: string;
  /** DB instance or cluster identifier extracted from the ARN. */
  identifier: string;
  /** Resource kind: standalone DB instance or Aurora/multi-AZ cluster. */
  type: 'db' | 'cluster';
  /** AWS account ID extracted from the ARN. */
  account: string;
  /** AWS region extracted from the ARN (used to select the RDS client). */
  region: string;
}

/**
 * Secret shape used to access Slack Web API.
 */
interface SlackSecret {
  /** Slack bot or user OAuth token. */
  token: string;
  /** Slack channel ID or name for notifications. */
  channel: string;
}

/**
 * Processing result for a single RDS resource.
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
 * Maps AWS regions to reusable RDS clients within a single Lambda invocation.
 * Ensures cross-region resources are targeted with the correct regional endpoint.
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
 * Parses an RDS ARN and extracts targeting metadata.
 *
 * Expected format: `arn:aws:rds:{region}:{account}:{type}/{identifier}`.
 *
 * @param arn Full RDS resource ARN.
 * @returns Parsed resource information including region, account, type, and identifier.
 */
const parseArn = (arn: string): TargetInfo => {
  const parts = arn.split(':');
  return {
    targetResource: arn,
    identifier: parts[6] ?? '',
    type: (parts[5] === 'cluster' ? 'cluster' : 'db') as 'db' | 'cluster',
    account: parts[4] ?? '',
    region: parts[3] ?? '',
  };
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
 * @param targetResource Target RDS resource ARN.
 * @param mode Requested operation mode.
 * @returns Final processing result including status and resource metadata.
 * @throws {Error} When the ARN region is missing, the resource reaches an unexpected status, or a DB instance is not found.
 */
const processing = async (
  context: DurableContext,
  targetResource: string,
  mode: 'Start' | 'Stop',
): Promise<ProcessingResult> => {
  const target = await context.step('get-identifier', async () => parseArn(targetResource));

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
 * applies start/stop actions with per-ARN region RDS clients, and posts
 * progress/results to Slack.
 *
 * Resource discovery uses the Lambda deployment region endpoint via
 * `ResourceGroupsTaggingAPIClient`; returned ARNs may refer to resources in
 * any region within the same account. RDS API calls use the region embedded
 * in each ARN.
 *
 * Requires `SLACK_SECRET_NAME` environment variable (set by the CDK construct).
 *
 * @param event Scheduler event payload containing tag filters and operation mode.
 * @param context Durable execution context from the durable execution SDK.
 * @returns Processed resource count and per-resource results.
 * @throws {Error} When required event parameters or environment variables are missing.
 */
export const handler = withDurableExecution(
  async (event: ScheduleEvent, context: DurableContext) => {
    const params = event.Params;
    if (!params?.TagKey || !params?.TagValues || !params?.Mode) {
      throw new Error('Invalid event: Params.TagKey, Params.TagValues, Params.Mode are required.');
    }
    // safe get Secrets name from environment variable
    const slackSecretName = SafeEnvGetter.getEnv('SLACK_SECRET_NAME');

    const slackSecretValue = await context.step('fetch-slack-secret', async () => {
      return secretFetcher.getSecretValue<SlackSecret>(slackSecretName);
    });

    const targetResources = await context.step('get-resources', async () => {
      const client = new ResourceGroupsTaggingAPIClient({});
      const response = await client.send(
        new GetResourcesCommand({
          ResourceTypeFilters: ['rds:db', 'rds:cluster'],
          TagFilters: [{ Key: params.TagKey, Values: params.TagValues }],
        }),
      );
      return (response.ResourceTagMappingList ?? []).map((m: ResourceTagMapping) => m.ResourceARN ?? '').filter(Boolean);
    });

    if (targetResources.length === 0) {
      return { processed: 0, results: [] };
    }

    const client = new WebClient(slackSecretValue.token);
    const channel = slackSecretValue.channel;

    // send slack message
    const slackParentMessageResult = await context.step('post-slack-messages', async () => {
      return client.chat.postMessage({
        channel,
        text: `${params.Mode === 'Start' ? '😆 Starts' : '🥱 Stops'} the scheduled RDS Database or Cluster.`,
      });
    });

    const results = await context.map(
      targetResources,
      async (ctx: DurableContext, targetResource: string, index: number) => {
        return ctx.runInChildContext(`resource-${index}`, async (childCtx: DurableContext) => {
          const result = await processing(childCtx, targetResource, params.Mode);
          if (result.status === 'skipped') {
            return result;
          }
          // send slack thread message
          await childCtx.step('post-slack-child-messages', async () => {
            const display = getStateDisplay(result.status);

            return client.chat.postMessage({
              channel,
              thread_ts: slackParentMessageResult?.ts,
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
