import { BatchItemStatus, type BatchResult, type DurableContext } from '@aws/durable-execution-sdk-js';
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
import type { Context } from 'aws-lambda';
import { secretFetcher } from 'aws-lambda-secret-fetcher';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { SafeEnvGetter } from 'safe-env-getter';

jest.mock('@aws/durable-execution-sdk-js', () => ({
  ...jest.requireActual('@aws/durable-execution-sdk-js'),
  withDurableExecution: <TEvent, TResult>(
    handler: (event: TEvent, context: DurableContext) => Promise<TResult>,
  ) => handler,
}));

jest.mock('aws-lambda-secret-fetcher', () => ({
  secretFetcher: {
    getSecretValue: jest.fn(),
  },
}));

jest.mock('safe-env-getter', () => ({
  SafeEnvGetter: {
    getEnv: jest.fn(),
  },
}));

const mockPostMessage = jest.fn().mockResolvedValue({ ts: '1234567890.123456' });

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

type HandlerFn = (
  event: ScheduleEvent,
  context: DurableContext,
) => Promise<{ processed: number; results: ProcessingResult[] }>;

interface ProcessingResult {
  resource: string;
  status: string;
  account: string;
  region: string;
  identifier: string;
  type: 'db' | 'cluster';
}

const createBatchResult = <T>(results: T[]): BatchResult<T> => ({
  all: results.map((result, index) => ({
    result,
    index,
    status: BatchItemStatus.SUCCEEDED,
  })),
  succeeded: () =>
    results.map((result, index) => ({
      result,
      index,
      status: BatchItemStatus.SUCCEEDED,
    })),
  failed: () => [],
  started: () => [],
  status: BatchItemStatus.SUCCEEDED,
  completionReason: 'ALL_COMPLETED',
  hasFailure: false,
  throwIfError: () => undefined,
  getResults: () => results,
  getErrors: () => [],
  successCount: results.length,
  failureCount: 0,
  startedCount: 0,
  totalCount: results.length,
});

const createMockDurableContext = (): DurableContext => {
  const ctx = {
    lambdaContext: {} as Context,
    logger: {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    },
    executionContext: {
      durableExecutionArn: 'arn:aws:lambda:ap-northeast-1:123456789012:function:test',
    },
    configureLogger: jest.fn(),
    step: jest.fn(
      async <TOutput>(
        nameOrFn: string | (() => Promise<TOutput>),
        maybeFn?: () => Promise<TOutput>,
      ): Promise<TOutput> => {
        const fn = typeof nameOrFn === 'function' ? nameOrFn : maybeFn;
        if (!fn) {
          throw new Error('step function is required');
        }
        return fn();
      },
    ),
    wait: jest.fn(async () => undefined),
    map: jest.fn(
      async <TInput, TOutput>(
        nameOrItems: string | TInput[],
        mapFuncOrItems?: ((context: DurableContext, item: TInput, index: number) => Promise<TOutput>) | TInput[],
        maybeMapFunc?: (context: DurableContext, item: TInput, index: number) => Promise<TOutput>,
      ): Promise<BatchResult<TOutput>> => {
        const items = Array.isArray(nameOrItems) ? nameOrItems : (mapFuncOrItems as TInput[]);
        const mapFunc = (
          Array.isArray(nameOrItems) ? mapFuncOrItems : maybeMapFunc
        ) as (context: DurableContext, item: TInput, index: number) => Promise<TOutput>;
        const results: TOutput[] = [];
        for (let index = 0; index < items.length; index += 1) {
          results.push(await mapFunc(ctx as unknown as DurableContext, items[index], index));
        }
        return createBatchResult(results);
      },
    ),
    runInChildContext: jest.fn(
      async <TOutput>(
        nameOrFn: string | ((childCtx: DurableContext) => Promise<TOutput>),
        maybeFn?: (childCtx: DurableContext) => Promise<TOutput>,
      ): Promise<TOutput> => {
        const fn = typeof nameOrFn === 'function' ? nameOrFn : maybeFn;
        if (!fn) {
          throw new Error('child context function is required');
        }
        return fn(ctx as unknown as DurableContext);
      },
    ),
    invoke: jest.fn(),
    waitForCondition: jest.fn(),
    createCallback: jest.fn(),
    waitForCallback: jest.fn(),
    parallel: jest.fn(),
    promise: {
      all: jest.fn(),
      allSettled: jest.fn(),
      any: jest.fn(),
      race: jest.fn(),
    },
  };
  return ctx as unknown as DurableContext;
};

const createEvent = (mode: 'Start' | 'Stop'): ScheduleEvent => ({
  Params: {
    TagKey: TAG_KEY,
    TagValues: TAG_VALUES,
    Mode: mode,
  },
});

const mockDiscoveredResources = (arns: string[]): void => {
  taggingMock.on(GetResourcesCommand).resolves({
    ResourceTagMappingList: arns.map((arn) => ({ ResourceARN: arn })),
  });
};

const rdsMock = mockClient(RDSClient);
const taggingMock = mockClient(ResourceGroupsTaggingAPIClient);

let handler: HandlerFn;

describe('running-schedule.lambda', () => {
  beforeAll(async () => {
    const mod = await import('../src/funcs/running-schedule.lambda');
    handler = mod.handler as unknown as HandlerFn;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    rdsMock.reset();
    taggingMock.reset();

    (SafeEnvGetter.getEnv as jest.Mock).mockReturnValue('example/slack/webhook');
    (secretFetcher.getSecretValue as jest.Mock).mockResolvedValue({
      token: 'xoxb-test-token',
      channel: 'C12345678',
    });
  });

  describe('handler validation', () => {
    it('throws when required event parameters are missing', async () => {
      const context = createMockDurableContext();
      await expect(handler({ Params: {} as ScheduleEvent['Params'] }, context)).rejects.toThrow(
        'Invalid event: Params.TagKey, Params.TagValues, Params.Mode are required.',
      );
    });

    it('returns empty results when no resources are discovered', async () => {
      taggingMock.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [] });
      const context = createMockDurableContext();

      const result = await handler(createEvent('Start'), context);

      expect(result).toEqual({ processed: 0, results: [] });
      expect(mockPostMessage).not.toHaveBeenCalled();
    });
  });

  describe('parseRdsArn via processing', () => {
    it('extracts account, region, identifier, and type from the target ARN', async () => {
      mockDiscoveredResources([dbArn]);
      rdsMock.on(DescribeDBInstancesCommand).resolves({
        DBInstances: [{ DBInstanceStatus: 'available' }],
      });

      const result = await handler(createEvent('Start'), createMockDurableContext());

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

      const context = createMockDurableContext();
      const result = await handler(createEvent('Start'), context);

      expect(result.results[0]?.status).toBe('available');
      expect(rdsMock).toHaveReceivedCommandWith(StartDBInstanceCommand, {
        DBInstanceIdentifier: 'test-db',
      });
      expect(context.wait).toHaveBeenCalledWith({ seconds: 60 });
    });

    it('starts a stopped cluster and returns available', async () => {
      mockDiscoveredResources([clusterArn]);
      rdsMock
        .on(DescribeDBClustersCommand)
        .resolvesOnce({ DBClusters: [{ Status: 'stopped' }] })
        .resolvesOnce({ DBClusters: [{ Status: 'available' }] });
      rdsMock.on(StartDBClusterCommand).resolves({});

      const result = await handler(createEvent('Start'), createMockDurableContext());

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

      const result = await handler(createEvent('Start'), createMockDurableContext());

      expect(result.results[0]?.status).toBe('available');
      expect(rdsMock).not.toHaveReceivedCommand(StartDBInstanceCommand);
      expect(rdsMock).not.toHaveReceivedCommand(StopDBInstanceCommand);
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

      const result = await handler(createEvent('Stop'), createMockDurableContext());

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

      const result = await handler(createEvent('Stop'), createMockDurableContext());

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

      const result = await handler(createEvent('Stop'), createMockDurableContext());

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

      const context = createMockDurableContext();
      const result = await handler(createEvent('Start'), context);

      expect(result.results[0]?.status).toBe('available');
      expect(context.wait).toHaveBeenCalledWith({ seconds: 60 });
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

      const context = createMockDurableContext();
      const result = await handler(createEvent('Stop'), context);

      expect(result.results[0]?.status).toBe('stopped');
      expect(context.wait).toHaveBeenCalledWith({ seconds: 60 });
      expect(rdsMock).toHaveReceivedCommandTimes(DescribeDBClustersCommand, 3);
    });
  });

  describe('not-found skip', () => {
    it('skips a cluster when DescribeDBClusters returns no status', async () => {
      mockDiscoveredResources([clusterArn]);
      rdsMock.on(DescribeDBClustersCommand).resolves({ DBClusters: [] });

      const result = await handler(createEvent('Start'), createMockDurableContext());

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

      const result = await handler(createEvent('Stop'), createMockDurableContext());

      expect(result.results[0]?.status).toBe('skipped');
      expect(rdsMock).not.toHaveReceivedCommand(StopDBClusterCommand);
    });

    it('skips a cluster when DbClusterNotFoundException is raised', async () => {
      mockDiscoveredResources([clusterArn]);
      rdsMock.on(DescribeDBClustersCommand).rejects({ name: 'DbClusterNotFoundException' });

      const result = await handler(createEvent('Stop'), createMockDurableContext());

      expect(result.results[0]?.status).toBe('skipped');
    });
  });

  describe('error handling', () => {
    it('throws when the DB instance is not found', async () => {
      mockDiscoveredResources([dbArn]);
      rdsMock.on(DescribeDBInstancesCommand).resolves({ DBInstances: [] });

      await expect(handler(createEvent('Start'), createMockDurableContext())).rejects.toThrow(
        'DB instance not found: test-db',
      );
    });

    it('throws when the DB instance reaches an unknown status', async () => {
      mockDiscoveredResources([dbArn]);
      rdsMock.on(DescribeDBInstancesCommand).resolves({
        DBInstances: [{ DBInstanceStatus: 'incompatible-restore' }],
      });

      await expect(handler(createEvent('Start'), createMockDurableContext())).rejects.toThrow(
        'db instance or cluster status fail: type=db identifier=test-db current=incompatible-restore',
      );
    });

    it('rethrows unexpected DescribeDBClusters errors', async () => {
      mockDiscoveredResources([clusterArn]);
      rdsMock.on(DescribeDBClustersCommand).rejects(new Error('network failure'));

      await expect(handler(createEvent('Stop'), createMockDurableContext())).rejects.toThrow(
        'network failure',
      );
    });
  });
});
