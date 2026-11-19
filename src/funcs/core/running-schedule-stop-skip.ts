/**
 * Pure decision for a stop the RDS API would reject.
 *
 * These helpers do not read the clock, environment, or AWS SDK. The Lambda
 * passes the engine and cluster attributes from Describe, and skips the stop
 * when a reason is returned.
 */
import { RUNNING_MODE_STOP, type RunningMode } from '../../settings/consts';

/** Engine names used by RDS Custom, such as `custom-oracle-ee`. */
const RDS_CUSTOM_ENGINE_PREFIX = 'custom-';

/** `EngineMode` of an Aurora Serverless v1 cluster. */
const AURORA_SERVERLESS_V1_ENGINE_MODE = 'serverless';

/** Older `EngineMode` of an Aurora global database cluster. */
const AURORA_GLOBAL_ENGINE_MODE = 'global';

/**
 * Attributes used to decide whether stop would be rejected.
 */
export interface StopEligibility {
  /** Requested operation mode. */
  readonly mode: RunningMode;
  /** Resource kind from the ARN. */
  readonly type: 'db' | 'cluster';
  /** DB instance or cluster identifier. */
  readonly identifier: string;
  /** `Engine` from Describe. Absent when the resource was not found. */
  readonly engine: string | undefined;
  /** `EngineMode` from DescribeDBClusters. */
  readonly engineMode: string | undefined;
  /** `GlobalClusterIdentifier` when the cluster belongs to a global database. */
  readonly globalClusterIdentifier: string | undefined;
  /** `ReadReplicaIdentifiers` of the cluster. Empty for a DB instance. */
  readonly readReplicaIdentifiers: readonly string[];
  /** `IsClusterWriter` of each cluster member. Empty for a DB instance. */
  readonly memberWriters: readonly boolean[];
}

const isRdsCustomEngine = (engine: string | undefined): boolean =>
  engine !== undefined && engine.startsWith(RDS_CUSTOM_ENGINE_PREFIX);

const hasClusterWriter = (memberWriters: readonly boolean[]): boolean =>
  memberWriters.includes(true);

/**
 * Returns whether this global-database cluster is one the stop API rejects.
 *
 * A global database can be stopped only when this cluster is its only member:
 * it has a writer and no read replica. `EngineMode` `global` is always rejected.
 *
 * @param eligibility Engine and cluster attributes for one resource.
 * @returns `true` when stop would be rejected.
 */
const isGlobalDatabaseStopBlocked = (eligibility: StopEligibility): boolean => {
  if (eligibility.engineMode === AURORA_GLOBAL_ENGINE_MODE) {
    return true;
  }
  const globalClusterIdentifier = eligibility.globalClusterIdentifier;
  if (globalClusterIdentifier === undefined || globalClusterIdentifier === '') {
    return false;
  }
  if (eligibility.readReplicaIdentifiers.length > 0) {
    return true;
  }
  return !hasClusterWriter(eligibility.memberWriters);
};

const resourceKindLabel = (type: StopEligibility['type']): string => {
  if (type === 'db') {
    return 'DB';
  }
  return 'cluster';
};

const stopSkipMessage = (eligibility: StopEligibility, reason: string): string =>
  `Cannot stop ${resourceKindLabel(eligibility.type)} ${eligibility.identifier}: ${reason}`;

/**
 * Returns why a stop must be skipped, or `undefined` when stop can proceed.
 *
 * Start is never skipped here. The caller leaves a missing resource to the
 * not-found path.
 *
 * @param eligibility Engine and cluster attributes for one resource.
 * @returns Reason recorded on the execution result and in Slack.
 */
export const stopSkipReason = (eligibility: StopEligibility): string | undefined => {
  if (eligibility.mode !== RUNNING_MODE_STOP) {
    return undefined;
  }
  if (isRdsCustomEngine(eligibility.engine)) {
    return stopSkipMessage(eligibility, 'RDS Custom does not support stop.');
  }
  if (eligibility.engineMode === AURORA_SERVERLESS_V1_ENGINE_MODE) {
    return stopSkipMessage(eligibility, 'Aurora Serverless v1 does not support stop.');
  }
  if (isGlobalDatabaseStopBlocked(eligibility)) {
    return stopSkipMessage(eligibility, 'this Aurora global database cluster does not support stop.');
  }
  return undefined;
};
