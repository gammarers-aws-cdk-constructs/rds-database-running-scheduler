import {
  nextPaginationToken,
  parseTargetRegions,
  selectTargetRegions,
} from '../src/funcs/core/running-schedule-discovery';
import { RdsDatabaseRunningSchedulerValidateError } from '../src/funcs/core/running-schedule-errors';

describe('parseTargetRegions', () => {
  it.each([
    { raw: '[]', expected: [] },
    { raw: '["us-east-1"]', expected: ['us-east-1'] },
    { raw: '["us-east-1","ap-northeast-1"]', expected: ['us-east-1', 'ap-northeast-1'] },
  ])('returns $expected for $raw', ({ raw, expected }) => {
    expect(parseTargetRegions(raw)).toEqual(expected);
  });

  it.each([
    { name: 'the text is not JSON', raw: 'us-east-1', message: 'TARGET_REGIONS must be a JSON array of region names' },
    { name: 'the value is not an array', raw: '"us-east-1"', message: 'TARGET_REGIONS must be a JSON array of region names' },
    { name: 'an element is not a string', raw: '["us-east-1", 1]', message: 'TARGET_REGIONS must be a JSON array of region names' },
    { name: 'a region name is empty', raw: '[""]', message: 'TARGET_REGIONS must not contain blank region names' },
    { name: 'a region name is whitespace', raw: '["us-east-1", "  "]', message: 'TARGET_REGIONS must not contain blank region names' },
    { name: 'a region name is repeated', raw: '["us-east-1","us-east-1"]', message: 'TARGET_REGIONS must not contain duplicate region names' },
  ])('rejects the value when $name', ({ raw, message }) => {
    expect(() => parseTargetRegions(raw)).toThrow(RdsDatabaseRunningSchedulerValidateError);
    expect(() => parseTargetRegions(raw)).toThrow(message);
  });
});

describe('selectTargetRegions', () => {
  const enabled = ['ap-northeast-1', 'us-east-1', 'eu-west-1'];

  it.each([
    { name: 'returns every enabled region when none are requested', target: [], expected: enabled },
    { name: 'returns only the requested region', target: ['us-east-1'], expected: ['us-east-1'] },
    {
      name: 'keeps the requested order',
      target: ['eu-west-1', 'ap-northeast-1'],
      expected: ['eu-west-1', 'ap-northeast-1'],
    },
  ])('$name', ({ target, expected }) => {
    expect(selectTargetRegions(enabled, target)).toEqual(expected);
  });

  it('returns a copy of the enabled regions', () => {
    expect(selectTargetRegions(enabled, [])).not.toBe(enabled);
  });

  it.each([
    { target: ['sa-east-1'], listed: 'sa-east-1' },
    { target: ['us-east-1', 'sa-east-1', 'af-south-1'], listed: 'sa-east-1, af-south-1' },
  ])('rejects regions that are not enabled: $listed', ({ target, listed }) => {
    expect(() => selectTargetRegions(enabled, target)).toThrow(RdsDatabaseRunningSchedulerValidateError);
    expect(() => selectTargetRegions(enabled, target)).toThrow(
      `targetRegions contains regions that are not enabled for the account: ${listed}`,
    );
  });
});

describe('nextPaginationToken', () => {
  it.each([
    { token: undefined, expected: undefined },
    { token: '', expected: undefined },
    { token: 'next-page', expected: 'next-page' },
  ])('returns $expected for $token', ({ token, expected }) => {
    expect(nextPaginationToken(token)).toBe(expected);
  });
});
