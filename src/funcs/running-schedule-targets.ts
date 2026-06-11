/**
 * Pure helpers for parsing RDS ARNs and deduplicating discovered targets.
 *
 * Used by the running schedule Lambda to prefer cluster-level start/stop over
 * Aurora member DB instance operations when both resource types are returned
 * by tag-based discovery.
 */

/**
 * Parsed metadata for an RDS resource ARN.
 */
export interface TargetInfo {
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
 * Parses an RDS ARN and extracts targeting metadata.
 *
 * Expected format: `arn:aws:rds:{region}:{account}:{type}/{identifier}`.
 *
 * @param arn Full RDS resource ARN.
 * @returns Parsed resource information including region, account, type, and identifier.
 */
export const parseRdsArn = (arn: string): TargetInfo => {
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
 * Builds a region-scoped key for an RDS cluster identifier.
 *
 * @param region AWS region of the cluster.
 * @param clusterIdentifier RDS cluster identifier.
 * @returns Composite key used for cluster membership checks.
 */
export const buildClusterKey = (region: string, clusterIdentifier: string): string =>
  `${region}:${clusterIdentifier}`;

/**
 * Collects region-scoped cluster keys from a list of RDS ARNs.
 *
 * @param arns RDS resource ARNs returned by resource discovery.
 * @returns Set of cluster keys for cluster-type ARNs.
 */
export const collectClusterKeysFromArns = (arns: readonly string[]): Set<string> => {
  const keys = new Set<string>();
  for (const arn of arns) {
    const info = parseRdsArn(arn);
    if (info.type === 'cluster') {
      keys.add(buildClusterKey(info.region, info.identifier));
    }
  }
  return keys;
};

/**
 * Returns whether a DB instance should be excluded because its parent cluster
 * is already targeted (cluster-priority deduplication).
 *
 * @param region AWS region of the DB instance.
 * @param dbClusterIdentifier Parent cluster identifier from DescribeDBInstances, if any.
 * @param clusterKeys Region-scoped cluster keys already present in the target list.
 * @returns `true` when the DB instance should be skipped in favor of cluster-level control.
 */
export const shouldExcludeClusterMemberDb = (
  region: string,
  dbClusterIdentifier: string | undefined,
  clusterKeys: ReadonlySet<string>,
): boolean => {
  if (clusterKeys.size === 0 || dbClusterIdentifier == null || dbClusterIdentifier === '') {
    return false;
  }
  return clusterKeys.has(buildClusterKey(region, dbClusterIdentifier));
};

/**
 * Filters discovered RDS ARNs so cluster member DB instances are excluded when
 * their parent cluster is also in the list.
 *
 * @param arns RDS resource ARNs returned by resource discovery.
 * @param dbClusterIdentifiers Map of DB instance ARN to parent cluster identifier.
 * @param clusterKeys Region-scoped cluster keys already present in the target list.
 * @returns ARNs to process, preferring cluster-level operations over member instances.
 */
export const filterClusterMemberDbs = (
  arns: readonly string[],
  dbClusterIdentifiers: ReadonlyMap<string, string | undefined>,
  clusterKeys: ReadonlySet<string>,
): string[] => {
  return arns.filter((arn) => {
    const info = parseRdsArn(arn);
    if (info.type === 'cluster') {
      return true;
    }
    const dbClusterIdentifier = dbClusterIdentifiers.get(arn);
    return !shouldExcludeClusterMemberDb(info.region, dbClusterIdentifier, clusterKeys);
  });
};
