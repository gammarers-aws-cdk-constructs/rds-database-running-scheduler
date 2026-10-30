import {
  LocalDurableTestRunner,
  OperationType,
  type TestResult,
} from '@aws/durable-execution-sdk-js-testing';
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
  ResourceGroupsTaggingAPIClient,
} from '@aws-sdk/client-resource-groups-tagging-api';
import { secretFetcher } from 'aws-lambda-secret-fetcher';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { StrictEnvResolver } from 'strict-env-resolver';
import { handler } from '../src/funcs/running-schedule.lambda';
import {
  LOG_MARKER_RESOURCE_STATUS_UNEXPECTED,
  LOG_MARKER_RESOURCE_WAIT_TIMED_OUT,
  LOG_MARKER_SCHEDULE_EXECUTION_FAILED,
} from '../src/settings/consts';

jest.mock('aws-lambda-secret-fetcher', () => ({
  secretFetcher: {
    getSecretValue: jest.fn(),
  },
}));

jest.mock('strict-env-resolver', () => ({
  StrictEnvResolver: {
    resolve: jest.fn(),
  },
  StrictEnvType: {
    String: { type: 'string' },
    Number: { type: 'number' },
    Boolean: { type: 'boolean' },
    Enum: jest.fn((choices: readonly string[]) => ({ type: 'enum', choices })),
  },
}));

const mockPostMessage = jest.fn().mockResolvedValue({ ts: '1234567890.123456' });

const mockEnv = (
  overrides: Partial<Record<string, string | number | boolean>> = {},
): void => {
  const values: Record<string, string | number | boolean> = {
    SLACK_SECRET_NAME: 'example/slack/webhook',
    WAIT_INTERVAL_SECONDS: 60,
    MAX_WAIT_SECONDS: 1800,
    TARGET_REGIONS: '[]',
    NOTIFY_SLACK_ON_WAIT_TIMEOUT: true,
    ...overrides,
  };
  (StrictEnvResolver.resolve as jest.Mock).mockImplementation((key: string) => {
    if (!(key in values)) {
      throw new Error(`Unexpected env key: ${key}`);
    }
    return values[key];
  });
};

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: {
      postMessage: mockPostMessage,
    },
  })),
}));

const ACCOUNT = '123456789012';
const REGION = 'ap-northeast-1';
const TAG_KEY = 'WorkHoursRunning';
const TAG_VALUES = ['YES'];

const dbArn = `arn:aws:rds:${REGION}:${ACCOUNT}:db:test-db`;
const clusterArn = `arn:aws:rds:${REGION}:${ACCOUNT}:cluster:test-cluster`;

interface ScheduleEvent {
  Params: {
    TagKey: string;
    TagValues: string[];
    Mode: 'Start' | 'Stop';
  };
}

interface ProcessingResult {
  resource: string;
  status: string;
  account: string;
  region: string;
  identifier: string;
  type: 'db' | 'cluster';
}

interface ScheduleResult {
  processed: number;
  results: ProcessingResult[];
}

const createEvent = (mode: 'Start' | 'Stop'): ScheduleEvent => ({
  Params: {
    TagKey: TAG_KEY,
    TagValues: TAG_VALUES,
    Mode: mode,
  },
});

const rdsMock = mockClient(RDSClient);
const taggingMock = mockClient(ResourceGroupsTaggingAPIClient);
const ec2Mock = mockClient(EC2Client);

const mockDiscoveredResources = (arns: string[]): void => {
  taggingMock.on(GetResourcesCommand).resolves({
    ResourceTagMappingList: arns.map((arn) => ({ ResourceARN: arn })),
  });
};

const mockEnabledRegions = (regions: string[]): void => {
  ec2Mock.on(DescribeRegionsCommand).resolves({
    Regions: regions.map((RegionName) => ({ RegionName })),
  });
};

/**
 * Lines the durable logger wrote to stdout/stderr, collected while a run is in progress.
 */
const writtenLogLines: string[] = [];

const collectWrites = (chunk: unknown): void => {
  writtenLogLines.push(String(chunk));
};

interface Run {
  readonly runner: LocalDurableTestRunner<ScheduleResult>;
  readonly execution: TestResult<ScheduleResult>;
}

const invoke = async (event: ScheduleEvent): Promise<Run> => {
  const runner = new LocalDurableTestRunner<ScheduleResult>({ handlerFunction: handler });
  const execution = await runner.run({ payload: event });
  return { runner, execution };
};

/**
 * Runs the handler and expects the execution to succeed.
 */
const runToSuccess = async (mode: 'Start' | 'Stop'): Promise<{ run: Run; result: ScheduleResult }> => {
  const run = await invoke(createEvent(mode));
  expect(run.execution.getStatus()).toBe('SUCCEEDED');
  const result = run.execution.getResult();
  if (result === undefined) {
    throw new Error('the execution succeeded without a result');
  }
  return { run, result };
};

/**
 * Runs the handler and expects the execution to fail.
 */
const runToFailure = async (event: ScheduleEvent) => {
  const run = await invoke(event);
  expect(run.execution.getStatus()).toBe('FAILED');
  return { run, error: run.execution.getError() };
};

/**
 * Names and durations of the `context.wait` calls, in the order they started.
 */
const waitsOf = (execution: TestResult<ScheduleResult>): Array<{ name: string | undefined; seconds: number | undefined }> => {
  return execution
    .getOperations()
    .filter((operation) => operation.getType() === OperationType.WAIT)
    .map((operation) => ({ name: operation.getName(), seconds: operation.getWaitDetails()?.waitSeconds }));
};

const loggedMessages = (): string => writtenLogLines.join('');

describe('running-schedule.lambda', () => {
  beforeAll(async () => {
    await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
  });

  afterAll(async () => {
    await LocalDurableTestRunner.teardownTestEnvironment();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    rdsMock.reset();
    taggingMock.reset();
    ec2Mock.reset();
    mockEnabledRegions([REGION]);

    mockEnv();
    (secretFetcher.getSecretValue as jest.Mock).mockResolvedValue({
      token: 'xoxb-test-token',
      channel: 'C12345678',
    });

    writtenLogLines.length = 0;
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      collectWrites(chunk);
      return true;
    });
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      collectWrites(chunk);
      return true;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('handler validation', () => {
    it('fails when required event parameters are missing', async () => {
      const { error } = await runToFailure({ Params: {} as ScheduleEvent['Params'] });

      expect(error.errorType).toBe('RdsDatabaseRunningSchedulerValidateError');
      expect(error.errorMessage).toBe(
        'Invalid event: Params.TagKey, Params.TagValues, Params.Mode are required.',
      );
    });

    it('returns empty results when no resources are discovered', async () => {
      taggingMock.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [] });

      const { result } = await runToSuccess('Start');

      expect(result).toEqual({ processed: 0, results: [] });
      expect(mockPostMessage).not.toHaveBeenCalled();
    });
  });

  describe('resource discovery regions', () => {
    const otherRegion = 'us-east-1';
    const otherDbArn = `arn:aws:rds:${otherRegion}:${ACCOUNT}:db:other-db`;

    // Answers each tag search with the resources of the region the client was built for.
    const mockTaggedResourcesByRegion = (arnsByRegion: Record<string, string[]>): void => {
      taggingMock.on(GetResourcesCommand).callsFake(async (_input, getClient) => {
        const region = await getClient().config.region();
        return { ResourceTagMappingList: (arnsByRegion[region] ?? []).map((arn) => ({ ResourceARN: arn })) };
      });
    };

    const searchedRegions = async (): Promise<string[]> => {
      const regions: string[] = [];
      for (const call of taggingMock.commandCalls(GetResourcesCommand)) {
        regions.push(await call.thisValue.config.region());
      }
      return regions;
    };

    beforeEach(() => {
      rdsMock.on(DescribeDBInstancesCommand).resolves({
        DBInstances: [{ DBInstanceStatus: 'available' }],
      });
    });

    it('searches every enabled region and processes resources found in other regions', async () => {
      mockEnabledRegions([REGION, otherRegion]);
      mockTaggedResourcesByRegion({ [REGION]: [dbArn], [otherRegion]: [otherDbArn] });

      const { result } = await runToSuccess('Start');

      expect(await searchedRegions()).toEqual([REGION, otherRegion]);
      expect(result.processed).toBe(2);
      expect(result.results.map((r) => r.region)).toEqual([REGION, otherRegion]);
      expect(result.results.map((r) => r.resource)).toEqual([dbArn, otherDbArn]);
    });

    it('searches only the regions named by TARGET_REGIONS', async () => {
      mockEnv({ TARGET_REGIONS: JSON.stringify([otherRegion]) });
      mockEnabledRegions([REGION, otherRegion]);
      mockTaggedResourcesByRegion({ [REGION]: [dbArn], [otherRegion]: [otherDbArn] });

      const { result } = await runToSuccess('Start');

      expect(await searchedRegions()).toEqual([otherRegion]);
      expect(result.results.map((r) => r.resource)).toEqual([otherDbArn]);
    });

    it('reads every page of tagged resources in a region', async () => {
      taggingMock
        .on(GetResourcesCommand)
        .resolvesOnce({
          PaginationToken: 'next-page',
          ResourceTagMappingList: [{ ResourceARN: dbArn }],
        })
        .resolvesOnce({
          PaginationToken: '',
          ResourceTagMappingList: [{ ResourceARN: clusterArn }],
        });
      rdsMock.on(DescribeDBClustersCommand).resolves({ DBClusters: [{ Status: 'available' }] });

      const { result } = await runToSuccess('Start');

      const calls = taggingMock.commandCalls(GetResourcesCommand);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.args[0].input.PaginationToken).toBeUndefined();
      expect(calls[1]?.args[0].input.PaginationToken).toBe('next-page');
      expect(result.results.map((r) => r.resource)).toEqual([dbArn, clusterArn]);
    });

    it('fails before searching when TARGET_REGIONS names a region that is not enabled', async () => {
      mockEnv({ TARGET_REGIONS: JSON.stringify([otherRegion]) });

      const { error } = await runToFailure(createEvent('Start'));

      expect(error.errorMessage).toBe(
        `targetRegions contains regions that are not enabled for the account: ${otherRegion}`,
      );
      expect(taggingMock).not.toHaveReceivedCommand(GetResourcesCommand);
    });
  });

  describe('Slack notification disabled', () => {
    beforeEach(() => {
      mockEnv({
        SLACK_SECRET_NAME: '',
        NOTIFY_SLACK_ON_WAIT_TIMEOUT: false,
      });
    });

    it('skips secret fetch and Slack API calls', async () => {
      mockDiscoveredResources([dbArn]);
      rdsMock.on(DescribeDBInstancesCommand).resolves({
        DBInstances: [{ DBInstanceStatus: 'available' }],
      });

      const { result } = await runToSuccess('Start');

      expect(result.results[0]?.status).toBe('available');
      expect(secretFetcher.getSecretValue).not.toHaveBeenCalled();
      expect(mockPostMessage).not.toHaveBeenCalled();
    });
  });

  describe('parseRdsArn via processing', () => {
    it('extracts account, region, identifier, and type from the target ARN', async () => {
      mockDiscoveredResources([dbArn]);
      rdsMock.on(DescribeDBInstancesCommand).resolves({
        DBInstances: [{ DBInstanceStatus: 'available' }],
      });

      const { result } = await runToSuccess('Start');

      expect(result.results[0]).toMatchObject({
        resource: dbArn,
        status: 'available',
        account: ACCOUNT,
        region: REGION,
        identifier: 'test-db',
        type: 'db',
      });
    });
  });

  describe('Start mode', () => {
    it('starts a stopped DB instance and returns available', async () => {
      mockDiscoveredResources([dbArn]);
      rdsMock
        .on(DescribeDBInstancesCommand)
        .resolvesOnce({ DBInstances: [{ DBInstanceStatus: 'stopped' }] })
        .resolvesOnce({ DBInstances: [{ DBInstanceStatus: 'available' }] });
      rdsMock.on(StartDBInstanceCommand).resolves({});

      const { run, result } = await runToSuccess('Start');

      expect(result.results[0]?.status).toBe('available');
      expect(rdsMock).toHaveReceivedCommandWith(StartDBInstanceCommand, {
        DBInstanceIdentifier: 'test-db',
      });
      expect(waitsOf(run.execution)).toEqual([{ name: 'wait-db-test-db-0', seconds: 60 }]);
    });

    it('starts a stopped cluster and returns available', async () => {
      mockDiscoveredResources([clusterArn]);
      rdsMock
        .on(DescribeDBClustersCommand)
        .resolvesOnce({ DBClusters: [{ Status: 'stopped' }] })
        .resolvesOnce({ DBClusters: [{ Status: 'available' }] });
      rdsMock.on(StartDBClusterCommand).resolves({});

      const { result } = await runToSuccess('Start');

      expect(result.results[0]?.status).toBe('available');
      expect(rdsMock).toHaveReceivedCommandWith(StartDBClusterCommand, {
        DBClusterIdentifier: 'test-cluster',
      });
    });

    it('returns immediately when the DB instance is already available', async () => {
      mockDiscoveredResources([dbArn]);
      rdsMock.on(DescribeDBInstancesCommand).resolves({
        DBInstances: [{ DBInstanceStatus: 'available' }],
      });

      const { run, result } = await runToSuccess('Start');

      expect(result.results[0]?.status).toBe('available');
      expect(rdsMock).not.toHaveReceivedCommand(StartDBInstanceCommand);
      expect(rdsMock).not.toHaveReceivedCommand(StopDBInstanceCommand);
      expect(waitsOf(run.execution)).toEqual([]);
    });
  });

  describe('Stop mode', () => {
    it('stops an available DB instance and returns stopped', async () => {
      mockDiscoveredResources([dbArn]);
      rdsMock
        .on(DescribeDBInstancesCommand)
        .resolvesOnce({ DBInstances: [{ DBInstanceStatus: 'available' }] })
        .resolvesOnce({ DBInstances: [{ DBInstanceStatus: 'stopped' }] });
      rdsMock.on(StopDBInstanceCommand).resolves({});

      const { result } = await runToSuccess('Stop');

      expect(result.results[0]?.status).toBe('stopped');
      expect(rdsMock).toHaveReceivedCommandWith(StopDBInstanceCommand, {
        DBInstanceIdentifier: 'test-db',
      });
    });

    it('stops an available cluster and returns stopped', async () => {
      mockDiscoveredResources([clusterArn]);
      rdsMock
        .on(DescribeDBClustersCommand)
        .resolvesOnce({ DBClusters: [{ Status: 'available' }] })
        .resolvesOnce({ DBClusters: [{ Status: 'stopped' }] });
      rdsMock.on(StopDBClusterCommand).resolves({});

      const { result } = await runToSuccess('Stop');

      expect(result.results[0]?.status).toBe('stopped');
      expect(rdsMock).toHaveReceivedCommandWith(StopDBClusterCommand, {
        DBClusterIdentifier: 'test-cluster',
      });
    });

    it('returns immediately when the cluster is already stopped', async () => {
      mockDiscoveredResources([clusterArn]);
      rdsMock.on(DescribeDBClustersCommand).resolves({
        DBClusters: [{ Status: 'stopped' }],
      });

      const { result } = await runToSuccess('Stop');

      expect(result.results[0]?.status).toBe('stopped');
      expect(rdsMock).not.toHaveReceivedCommand(StopDBClusterCommand);
    });
  });

  describe('transitioning statuses', () => {
    it('waits while the DB instance is starting, then returns available', async () => {
      mockDiscoveredResources([dbArn]);
      rdsMock
        .on(DescribeDBInstancesCommand)
        .resolvesOnce({ DBInstances: [{ DBInstanceStatus: 'stopped' }] })
        .resolvesOnce({ DBInstances: [{ DBInstanceStatus: 'starting' }] })
        .resolvesOnce({ DBInstances: [{ DBInstanceStatus: 'available' }] });
      rdsMock.on(StartDBInstanceCommand).resolves({});

      const { run, result } = await runToSuccess('Start');

      expect(result.results[0]?.status).toBe('available');
      expect(waitsOf(run.execution)).toEqual([
        { name: 'wait-db-test-db-0', seconds: 60 },
        { name: 'wait-db-test-db-1', seconds: 60 },
      ]);
      expect(rdsMock).toHaveReceivedCommandTimes(DescribeDBInstancesCommand, 3);
    });

    it('waits while the cluster is stopping, then returns stopped', async () => {
      mockDiscoveredResources([clusterArn]);
      rdsMock
        .on(DescribeDBClustersCommand)
        .resolvesOnce({ DBClusters: [{ Status: 'available' }] })
        .resolvesOnce({ DBClusters: [{ Status: 'stopping' }] })
        .resolvesOnce({ DBClusters: [{ Status: 'stopped' }] });
      rdsMock.on(StopDBClusterCommand).resolves({});

      const { run, result } = await runToSuccess('Stop');

      expect(result.results[0]?.status).toBe('stopped');
      expect(waitsOf(run.execution)).toEqual([
        { name: 'wait-cluster-test-cluster-0', seconds: 60 },
        { name: 'wait-cluster-test-cluster-1', seconds: 60 },
      ]);
      expect(rdsMock).toHaveReceivedCommandTimes(DescribeDBClustersCommand, 3);
    });

    it.each([
      'storage-optimization',
      'configuring-iam-database-auth',
      'configuring-log-exports',
    ])('waits for stopped while Start sees %s, then starts the DB instance', async (transitioning) => {
      mockDiscoveredResources([dbArn]);
      rdsMock
        .on(DescribeDBInstancesCommand)
        .resolvesOnce({ DBInstances: [{ DBInstanceStatus: transitioning }] })
        .resolvesOnce({ DBInstances: [{ DBInstanceStatus: 'stopped' }] })
        .resolvesOnce({ DBInstances: [{ DBInstanceStatus: 'available' }] });
      rdsMock.on(StartDBInstanceCommand).resolves({});

      const { run, result } = await runToSuccess('Start');

      expect(result.results[0]?.status).toBe('available');
      expect(rdsMock).toHaveReceivedCommandTimes(StartDBInstanceCommand, 1);
      expect(waitsOf(run.execution).map((wait) => wait.name)).toEqual([
        'wait-db-test-db-0',
        'wait-db-test-db-1',
      ]);
    });

    it('waits while Stop sees storage-optimization instead of failing', async () => {
      mockDiscoveredResources([dbArn]);
      rdsMock
        .on(DescribeDBInstancesCommand)
        .resolvesOnce({ DBInstances: [{ DBInstanceStatus: 'storage-optimization' }] })
        .resolvesOnce({ DBInstances: [{ DBInstanceStatus: 'stopped' }] });

      const { result } = await runToSuccess('Stop');

      expect(result.results[0]?.status).toBe('stopped');
      expect(rdsMock).not.toHaveReceivedCommand(StopDBInstanceCommand);
    });
  });

  describe('not-found skip', () => {
    it('skips a cluster when DescribeDBClusters returns no status', async () => {
      mockDiscoveredResources([clusterArn]);
      rdsMock.on(DescribeDBClustersCommand).resolves({ DBClusters: [] });

      const { result } = await runToSuccess('Start');

      expect(result.results[0]).toMatchObject({
        resource: clusterArn,
        status: 'skipped',
        identifier: 'test-cluster',
        type: 'cluster',
      });
      expect(rdsMock).not.toHaveReceivedCommand(StartDBClusterCommand);
      expect(mockPostMessage).toHaveBeenCalledTimes(1);
    });

    it('skips a cluster when DBClusterNotFoundFault is raised', async () => {
      mockDiscoveredResources([clusterArn]);
      rdsMock.on(DescribeDBClustersCommand).rejects({ name: 'DBClusterNotFoundFault' });

      const { result } = await runToSuccess('Stop');

      expect(result.results[0]?.status).toBe('skipped');
      expect(rdsMock).not.toHaveReceivedCommand(StopDBClusterCommand);
    });

    it('skips a cluster when DbClusterNotFoundException is raised', async () => {
      mockDiscoveredResources([clusterArn]);
      rdsMock.on(DescribeDBClustersCommand).rejects({ name: 'DbClusterNotFoundException' });

      const { result } = await runToSuccess('Stop');

      expect(result.results[0]?.status).toBe('skipped');
    });
  });

  describe('error handling', () => {
    it('fails when the DB instance is not found', async () => {
      mockDiscoveredResources([dbArn]);
      rdsMock.on(DescribeDBInstancesCommand).resolves({ DBInstances: [] });

      const { error } = await runToFailure(createEvent('Start'));

      expect(error.errorMessage).toContain('DB instance not found: test-db');
    });

    it('fails when the DB instance reaches an unknown status', async () => {
      mockDiscoveredResources([dbArn]);
      rdsMock.on(DescribeDBInstancesCommand).resolves({
        DBInstances: [{ DBInstanceStatus: 'incompatible-restore' }],
      });

      const { error } = await runToFailure(createEvent('Start'));

      expect(error.errorMessage).toBe(
        'db instance or cluster status fail: type=db identifier=test-db current=incompatible-restore',
      );
    });

    it('fails when DescribeDBClusters raises an unexpected error', async () => {
      mockDiscoveredResources([clusterArn]);
      rdsMock.on(DescribeDBClustersCommand).rejects(new Error('network failure'));

      const { error } = await runToFailure(createEvent('Stop'));

      expect(error.errorMessage).toContain('network failure');
    });

    it('processes the other resources before failing when one resource fails', async () => {
      mockDiscoveredResources([dbArn, clusterArn]);
      rdsMock.on(DescribeDBInstancesCommand).resolves({
        DBInstances: [{ DBInstanceStatus: 'incompatible-restore' }],
      });
      rdsMock.on(DescribeDBClustersCommand).resolves({ DBClusters: [{ Status: 'available' }] });

      await runToFailure(createEvent('Start'));

      expect(rdsMock).toHaveReceivedCommand(DescribeDBClustersCommand);
    });
  });

  describe('failure logs for failure detection', () => {
    it('logs the unexpected status marker and the execution failure marker', async () => {
      mockDiscoveredResources([dbArn]);
      rdsMock.on(DescribeDBInstancesCommand).resolves({
        DBInstances: [{ DBInstanceStatus: 'incompatible-restore' }],
      });

      await runToFailure(createEvent('Start'));

      const logs = loggedMessages();
      expect(logs).toContain(`${LOG_MARKER_RESOURCE_STATUS_UNEXPECTED}: db instance or cluster status fail`);
      expect(logs).toContain(LOG_MARKER_SCHEDULE_EXECUTION_FAILED);
      expect(logs).not.toContain(LOG_MARKER_RESOURCE_WAIT_TIMED_OUT);
    });

    it('logs the wait timeout marker and the execution failure marker', async () => {
      mockEnv({ WAIT_INTERVAL_SECONDS: 60, MAX_WAIT_SECONDS: 60 });
      mockDiscoveredResources([dbArn]);
      rdsMock.on(DescribeDBInstancesCommand).resolves({ DBInstances: [{ DBInstanceStatus: 'starting' }] });

      await runToFailure(createEvent('Start'));

      const logs = loggedMessages();
      expect(logs).toContain(`${LOG_MARKER_RESOURCE_WAIT_TIMED_OUT}: wait timed out`);
      expect(logs).toContain(LOG_MARKER_SCHEDULE_EXECUTION_FAILED);
      expect(logs).not.toContain(LOG_MARKER_RESOURCE_STATUS_UNEXPECTED);
    });

    it('logs only the execution failure marker for a validation failure', async () => {
      await runToFailure({ Params: {} as ScheduleEvent['Params'] });

      const logs = loggedMessages();
      expect(logs).toContain(LOG_MARKER_SCHEDULE_EXECUTION_FAILED);
      expect(logs).not.toContain(LOG_MARKER_RESOURCE_WAIT_TIMED_OUT);
      expect(logs).not.toContain(LOG_MARKER_RESOURCE_STATUS_UNEXPECTED);
    });

    it('logs no failure marker when every resource succeeds', async () => {
      mockDiscoveredResources([dbArn]);
      rdsMock.on(DescribeDBInstancesCommand).resolves({ DBInstances: [{ DBInstanceStatus: 'available' }] });

      await runToSuccess('Start');

      const logs = loggedMessages();
      expect(logs).not.toContain(LOG_MARKER_SCHEDULE_EXECUTION_FAILED);
      expect(logs).not.toContain(LOG_MARKER_RESOURCE_WAIT_TIMED_OUT);
      expect(logs).not.toContain(LOG_MARKER_RESOURCE_STATUS_UNEXPECTED);
    });
  });

  describe('configurable wait', () => {
    it('waits using WAIT_INTERVAL_SECONDS', async () => {
      mockEnv({ WAIT_INTERVAL_SECONDS: 15 });
      mockDiscoveredResources([dbArn]);
      rdsMock
        .on(DescribeDBInstancesCommand)
        .resolvesOnce({ DBInstances: [{ DBInstanceStatus: 'stopped' }] })
        .resolvesOnce({ DBInstances: [{ DBInstanceStatus: 'available' }] });
      rdsMock.on(StartDBInstanceCommand).resolves({});

      const { run, result } = await runToSuccess('Start');

      expect(result.results[0]?.status).toBe('available');
      expect(waitsOf(run.execution)).toEqual([{ name: 'wait-db-test-db-0', seconds: 15 }]);
    });

    it('fails when the wait budget is exhausted', async () => {
      mockEnv({ WAIT_INTERVAL_SECONDS: 60, MAX_WAIT_SECONDS: 120 });
      mockDiscoveredResources([dbArn]);
      rdsMock
        .on(DescribeDBInstancesCommand)
        .resolvesOnce({ DBInstances: [{ DBInstanceStatus: 'stopped' }] })
        .resolvesOnce({ DBInstances: [{ DBInstanceStatus: 'starting' }] })
        .resolves({ DBInstances: [{ DBInstanceStatus: 'starting' }] });
      rdsMock.on(StartDBInstanceCommand).resolves({});

      const { run, error } = await runToFailure(createEvent('Start'));

      expect(error.errorMessage).toBe('wait timed out: type=db identifier=test-db maxWaitSeconds=120');
      expect(waitsOf(run.execution)).toEqual([
        { name: 'wait-db-test-db-0', seconds: 60 },
        { name: 'wait-db-test-db-1', seconds: 60 },
      ]);
      expect(rdsMock).toHaveReceivedCommandTimes(StartDBInstanceCommand, 1);
    });

    it('posts a Slack timeout message when notification is enabled', async () => {
      mockEnv({ WAIT_INTERVAL_SECONDS: 60, MAX_WAIT_SECONDS: 60, NOTIFY_SLACK_ON_WAIT_TIMEOUT: true });
      mockDiscoveredResources([dbArn]);
      rdsMock.on(DescribeDBInstancesCommand).resolves({ DBInstances: [{ DBInstanceStatus: 'starting' }] });

      const { error } = await runToFailure(createEvent('Start'));

      expect(error.errorMessage).toBe('wait timed out: type=db identifier=test-db maxWaitSeconds=60');
      expect(mockPostMessage).toHaveBeenCalledTimes(2);
      expect(mockPostMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
        channel: 'C12345678',
        thread_ts: '1234567890.123456',
        attachments: [
          expect.objectContaining({
            color: '#e01e5a',
            pretext: 'The RDS db test-db did not reach the target state within the wait limit.',
            fields: expect.arrayContaining([
              { title: 'Identifier', value: 'test-db', short: true },
              { title: 'Status', value: 'TIMED_OUT', short: true },
              { title: 'Max wait (seconds)', value: '60', short: true },
            ]),
          }),
        ],
      }));
    });

    it('skips the Slack timeout message when notification is disabled', async () => {
      mockEnv({ WAIT_INTERVAL_SECONDS: 60, MAX_WAIT_SECONDS: 60, NOTIFY_SLACK_ON_WAIT_TIMEOUT: false });
      mockDiscoveredResources([clusterArn]);
      rdsMock.on(DescribeDBClustersCommand).resolves({ DBClusters: [{ Status: 'stopping' }] });

      const { error } = await runToFailure(createEvent('Stop'));

      expect(error.errorMessage).toBe('wait timed out: type=cluster identifier=test-cluster maxWaitSeconds=60');
      expect(mockPostMessage).toHaveBeenCalledTimes(1);
    });

    it('fails on invalid wait settings before calling RDS', async () => {
      mockEnv({ WAIT_INTERVAL_SECONDS: 1.5 });

      const { error } = await runToFailure(createEvent('Start'));

      expect(error.errorType).toBe('RdsDatabaseRunningSchedulerValidateError');
      expect(error.errorMessage).toBe('resourceWait.intervalSeconds must be a positive integer');
      expect(rdsMock).not.toHaveReceivedCommand(DescribeDBInstancesCommand);
    });
  });

  describe('wait timeout without Slack', () => {
    beforeEach(() => {
      mockEnv({
        SLACK_SECRET_NAME: '',
        NOTIFY_SLACK_ON_WAIT_TIMEOUT: false,
        WAIT_INTERVAL_SECONDS: 60,
        MAX_WAIT_SECONDS: 60,
      });
    });

    it('fails without fetching a secret or posting to Slack', async () => {
      mockDiscoveredResources([dbArn]);
      rdsMock.on(DescribeDBInstancesCommand).resolves({
        DBInstances: [{ DBInstanceStatus: 'starting' }],
      });

      const { error } = await runToFailure(createEvent('Start'));

      expect(error.errorMessage).toBe('wait timed out: type=db identifier=test-db maxWaitSeconds=60');
      expect(secretFetcher.getSecretValue).not.toHaveBeenCalled();
      expect(mockPostMessage).not.toHaveBeenCalled();
    });
  });
});
