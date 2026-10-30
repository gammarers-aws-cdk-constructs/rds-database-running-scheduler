/**
 * Pure helpers for choosing which regions to search and paging through results.
 *
 * These helpers do not read the clock, environment, or AWS SDK. The Lambda
 * passes in the enabled regions and the raw `TARGET_REGIONS` value, then
 * searches each returned region with the Resource Groups Tagging API.
 */
import { RdsDatabaseRunningSchedulerValidateError } from './running-schedule-errors';

/**
 * Parses the `TARGET_REGIONS` environment value.
 *
 * The construct writes a JSON array of region names. An empty array means
 * every enabled region.
 *
 * @param raw JSON text read from `TARGET_REGIONS`.
 * @returns Region names in the given order.
 * @throws {RdsDatabaseRunningSchedulerValidateError} When the text is not valid JSON, is not
 * an array of strings, or contains a blank or duplicate region name.
 */
export const parseTargetRegions = (raw: string): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RdsDatabaseRunningSchedulerValidateError('TARGET_REGIONS must be a JSON array of region names');
  }
  if (!Array.isArray(parsed) || !parsed.every((region): region is string => typeof region === 'string')) {
    throw new RdsDatabaseRunningSchedulerValidateError('TARGET_REGIONS must be a JSON array of region names');
  }
  if (parsed.some((region) => region.trim().length === 0)) {
    throw new RdsDatabaseRunningSchedulerValidateError('TARGET_REGIONS must not contain blank region names');
  }
  if (new Set(parsed).size !== parsed.length) {
    throw new RdsDatabaseRunningSchedulerValidateError('TARGET_REGIONS must not contain duplicate region names');
  }
  return parsed;
};

/**
 * Chooses the regions to search for tagged resources.
 *
 * @param enabledRegions Regions enabled for the account, from `DescribeRegions`.
 * @param targetRegions Regions requested through `targetRegions`. Empty means all enabled regions.
 * @returns Every enabled region when `targetRegions` is empty, otherwise `targetRegions` as given.
 * @throws {RdsDatabaseRunningSchedulerValidateError} When `targetRegions` names a region that is
 * not enabled for the account.
 */
export const selectTargetRegions = (
  enabledRegions: readonly string[],
  targetRegions: readonly string[],
): string[] => {
  if (targetRegions.length === 0) {
    return [...enabledRegions];
  }
  const enabled = new Set(enabledRegions);
  const notEnabled = targetRegions.filter((region) => !enabled.has(region));
  if (notEnabled.length > 0) {
    throw new RdsDatabaseRunningSchedulerValidateError(
      `targetRegions contains regions that are not enabled for the account: ${notEnabled.join(', ')}`,
    );
  }
  return [...targetRegions];
};

/**
 * Returns the token for the next page of tagged resources.
 *
 * The Resource Groups Tagging API returns an empty string on the last page.
 *
 * @param paginationToken `PaginationToken` from the latest response.
 * @returns The token to request the next page, or `undefined` when there are no more pages.
 */
export const nextPaginationToken = (paginationToken: string | undefined): string | undefined =>
  paginationToken === undefined || paginationToken === '' ? undefined : paginationToken;
