import {
  buildClusterKey,
  collectClusterKeysFromArns,
  filterClusterMemberDbs,
  shouldExcludeClusterMemberDb,
} from '../src/funcs/running-schedule-targets';

describe('buildClusterKey', () => {
  it('combines region and cluster identifier', () => {
    expect(buildClusterKey('ap-northeast-1', 'my-cluster')).toBe('ap-northeast-1:my-cluster');
  });
});

describe('collectClusterKeysFromArns', () => {
  it('collects keys only from cluster ARNs', () => {
    const arns = [
      'arn:aws:rds:ap-northeast-1:123456789012:cluster:my-cluster',
      'arn:aws:rds:ap-northeast-1:123456789012:db:my-cluster-instance-1',
      'arn:aws:rds:us-east-1:123456789012:cluster:other-cluster',
    ];
    expect(collectClusterKeysFromArns(arns)).toEqual(
      new Set(['ap-northeast-1:my-cluster', 'us-east-1:other-cluster']),
    );
  });
});

describe('shouldExcludeClusterMemberDb', () => {
  it.each([
    {
      name: 'excludes when parent cluster is in the target list',
      region: 'ap-northeast-1',
      dbClusterIdentifier: 'my-cluster',
      clusterKeys: new Set(['ap-northeast-1:my-cluster']),
      expected: true,
    },
    {
      name: 'keeps standalone DB when no cluster keys exist',
      region: 'ap-northeast-1',
      dbClusterIdentifier: 'my-cluster',
      clusterKeys: new Set<string>(),
      expected: false,
    },
    {
      name: 'keeps DB instance without a parent cluster',
      region: 'ap-northeast-1',
      dbClusterIdentifier: undefined,
      clusterKeys: new Set(['ap-northeast-1:my-cluster']),
      expected: false,
    },
    {
      name: 'keeps DB instance when parent cluster is not targeted',
      region: 'ap-northeast-1',
      dbClusterIdentifier: 'other-cluster',
      clusterKeys: new Set(['ap-northeast-1:my-cluster']),
      expected: false,
    },
    {
      name: 'keeps DB instance when cluster id matches but region differs',
      region: 'us-east-1',
      dbClusterIdentifier: 'my-cluster',
      clusterKeys: new Set(['ap-northeast-1:my-cluster']),
      expected: false,
    },
  ])('$name', ({ region, dbClusterIdentifier, clusterKeys, expected }) => {
    expect(shouldExcludeClusterMemberDb(region, dbClusterIdentifier, clusterKeys)).toBe(expected);
  });
});

describe('filterClusterMemberDbs', () => {
  const clusterArn = 'arn:aws:rds:ap-northeast-1:123456789012:cluster:my-cluster';
  const memberDbArn = 'arn:aws:rds:ap-northeast-1:123456789012:db:my-cluster-instance-1';
  const standaloneDbArn = 'arn:aws:rds:ap-northeast-1:123456789012:db:standalone-db';

  it('removes cluster member DB instances when their cluster is also targeted', () => {
    const arns = [clusterArn, memberDbArn, standaloneDbArn];
    const clusterKeys = collectClusterKeysFromArns(arns);
    const dbClusterIdentifiers = new Map<string, string | undefined>([
      [memberDbArn, 'my-cluster'],
      [standaloneDbArn, undefined],
    ]);

    expect(filterClusterMemberDbs(arns, dbClusterIdentifiers, clusterKeys)).toEqual([
      clusterArn,
      standaloneDbArn,
    ]);
  });

  it('keeps all DB instances when no cluster ARNs are present', () => {
    const arns = [memberDbArn, standaloneDbArn];
    const clusterKeys = collectClusterKeysFromArns(arns);
    const dbClusterIdentifiers = new Map<string, string | undefined>([
      [memberDbArn, 'my-cluster'],
      [standaloneDbArn, undefined],
    ]);

    expect(filterClusterMemberDbs(arns, dbClusterIdentifiers, clusterKeys)).toEqual(arns);
  });
});
