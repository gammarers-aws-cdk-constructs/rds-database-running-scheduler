import {
  stopSkipReason,
  type StopEligibility,
} from '../src/funcs/core/running-schedule-stop-skip';

const eligibility = (overrides: Partial<StopEligibility> = {}): StopEligibility => ({
  mode: 'Stop',
  type: 'db',
  identifier: 'test-db',
  engine: 'postgres',
  engineMode: undefined,
  globalClusterIdentifier: undefined,
  readReplicaIdentifiers: [],
  memberWriters: [],
  ...overrides,
});

describe('stopSkipReason', () => {
  it.each([
    {
      name: 'an RDS Custom for Oracle instance',
      eligibility: eligibility({ engine: 'custom-oracle-ee' }),
      expected: 'Cannot stop DB test-db: RDS Custom does not support stop.',
    },
    {
      name: 'an RDS Custom for SQL Server instance',
      eligibility: eligibility({ engine: 'custom-sqlserver-web' }),
      expected: 'Cannot stop DB test-db: RDS Custom does not support stop.',
    },
    {
      name: 'a PostgreSQL instance',
      eligibility: eligibility({ engine: 'postgres' }),
      expected: undefined,
    },
    {
      name: 'an instance whose engine was not returned',
      eligibility: eligibility({ engine: undefined }),
      expected: undefined,
    },
    {
      name: 'a start of RDS Custom',
      eligibility: eligibility({ mode: 'Start', engine: 'custom-oracle-ee' }),
      expected: undefined,
    },
    {
      name: 'Aurora Serverless v1',
      eligibility: eligibility({
        type: 'cluster',
        identifier: 'test-cluster',
        engine: 'aurora-mysql',
        engineMode: 'serverless',
        memberWriters: [true],
      }),
      expected: 'Cannot stop cluster test-cluster: Aurora Serverless v1 does not support stop.',
    },
    {
      name: 'Aurora Serverless v2',
      eligibility: eligibility({
        type: 'cluster',
        identifier: 'test-cluster',
        engine: 'aurora-postgresql',
        engineMode: 'provisioned',
        memberWriters: [true],
      }),
      expected: undefined,
    },
    {
      name: 'a cluster whose EngineMode is global',
      eligibility: eligibility({
        type: 'cluster',
        identifier: 'test-cluster',
        engine: 'aurora-mysql',
        engineMode: 'global',
        memberWriters: [true],
      }),
      expected: 'Cannot stop cluster test-cluster: this Aurora global database cluster does not support stop.',
    },
    {
      name: 'a global database cluster that has read replicas',
      eligibility: eligibility({
        type: 'cluster',
        identifier: 'test-cluster',
        engine: 'aurora-mysql',
        engineMode: 'provisioned',
        globalClusterIdentifier: 'global-1',
        readReplicaIdentifiers: ['arn:aws:rds:us-east-1:123456789012:cluster:secondary'],
        memberWriters: [true],
      }),
      expected: 'Cannot stop cluster test-cluster: this Aurora global database cluster does not support stop.',
    },
    {
      name: 'a global database cluster without a writer',
      eligibility: eligibility({
        type: 'cluster',
        identifier: 'test-cluster',
        engine: 'aurora-mysql',
        engineMode: 'provisioned',
        globalClusterIdentifier: 'global-1',
        memberWriters: [false],
      }),
      expected: 'Cannot stop cluster test-cluster: this Aurora global database cluster does not support stop.',
    },
    {
      name: 'the only cluster in a global database',
      eligibility: eligibility({
        type: 'cluster',
        identifier: 'test-cluster',
        engine: 'aurora-mysql',
        engineMode: 'provisioned',
        globalClusterIdentifier: 'global-1',
        memberWriters: [false, true],
      }),
      expected: undefined,
    },
    {
      name: 'a blank global cluster identifier',
      eligibility: eligibility({
        type: 'cluster',
        identifier: 'test-cluster',
        engine: 'aurora-mysql',
        engineMode: 'provisioned',
        globalClusterIdentifier: '',
        memberWriters: [false],
      }),
      expected: undefined,
    },
    {
      name: 'a cluster with no global cluster identifier',
      eligibility: eligibility({
        type: 'cluster',
        identifier: 'test-cluster',
        engine: 'aurora-mysql',
        engineMode: 'provisioned',
        globalClusterIdentifier: undefined,
        memberWriters: [false],
      }),
      expected: undefined,
    },
  ])('returns $expected for $name', ({ eligibility: described, expected }) => {
    expect(stopSkipReason(described)).toBe(expected);
  });
});
