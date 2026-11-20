import {
  failedMapItemNames,
  hasMapFailure,
  MAP_COMPLETION,
  MAP_FAILURE_NAME_LIMIT,
  mapCompletionConfig,
  mapFailureMessage,
  mapFailureNamesForMessage,
  mapItemOutcomes,
  notStartedMapItemCount,
  type MapItemOutcome,
  type ObservedMapItem,
} from '../src/funcs/core/running-schedule-map';

const outcome = (name: string, state: MapItemOutcome['state']): MapItemOutcome => ({ name, state });

describe('mapCompletionConfig', () => {
  it.each([
    {
      completion: MAP_COMPLETION.CONTINUE,
      expected: { toleratedFailurePercentage: 100 },
    },
    {
      completion: MAP_COMPLETION.FAIL_FAST,
      expected: undefined,
    },
  ])('maps $completion', ({ completion, expected }) => {
    expect(mapCompletionConfig(completion)).toEqual(expected);
  });
});

describe('hasMapFailure', () => {
  it.each([
    { name: 'no items', items: [], expected: false },
    { name: 'only successes', items: [outcome('db-a', 'succeeded')], expected: false },
    { name: 'a resource that never started', items: [outcome('db-a', 'not-started')], expected: false },
    { name: 'one failure', items: [outcome('db-a', 'failed')], expected: true },
    {
      name: 'a failure after a success',
      items: [outcome('db-a', 'succeeded'), outcome('db-b', 'failed')],
      expected: true,
    },
  ])('returns $expected for $name', ({ items, expected }) => {
    expect(hasMapFailure(items)).toBe(expected);
  });
});

describe('failedMapItemNames', () => {
  it('keeps failed names in input order', () => {
    const items = [
      outcome('db-a', 'succeeded'),
      outcome('db-b', 'failed'),
      outcome('db-c', 'not-started'),
      outcome('db-d', 'failed'),
    ];
    expect(failedMapItemNames(items)).toEqual(['db-b', 'db-d']);
  });
});

describe('notStartedMapItemCount', () => {
  it.each([
    { name: 'none', items: [outcome('db-a', 'succeeded'), outcome('db-b', 'failed')], expected: 0 },
    { name: 'two', items: [outcome('db-a', 'not-started'), outcome('db-b', 'not-started')], expected: 2 },
  ])('counts $expected when $name were not started', ({ items, expected }) => {
    expect(notStartedMapItemCount(items)).toBe(expected);
  });
});

describe('mapFailureNamesForMessage', () => {
  it.each([
    {
      name: 'keeps every name under the limit',
      names: ['db-a', 'db-b'],
      limit: MAP_FAILURE_NAME_LIMIT,
      shown: ['db-a', 'db-b'],
      hiddenCount: 0,
    },
    {
      name: 'leaves names past the limit unlisted',
      names: ['db-a', 'db-b', 'db-c', 'db-d'],
      limit: 2,
      shown: ['db-a', 'db-b'],
      hiddenCount: 2,
    },
  ])('$name', ({ names, limit, shown, hiddenCount }) => {
    expect(mapFailureNamesForMessage(names, limit)).toEqual({ shown, hiddenCount });
  });
});

describe('mapFailureMessage', () => {
  const failed = (count: number): MapItemOutcome[] =>
    Array.from({ length: count }, (_, index) => outcome(`db-${index}`, 'failed'));

  it('names a single failed resource', () => {
    expect(mapFailureMessage([outcome('test-db', 'failed')])).toBe('1 resource failed: test-db');
  });

  it('names every failed resource under the limit', () => {
    expect(mapFailureMessage([
      outcome('test-db', 'failed'),
      outcome('test-cluster', 'succeeded'),
      outcome('other-db', 'failed'),
    ])).toBe('2 resources failed: test-db, other-db');
  });

  it('caps the listed names and counts the rest', () => {
    const hidden = 12 - MAP_FAILURE_NAME_LIMIT;
    const shown = Array.from({ length: MAP_FAILURE_NAME_LIMIT }, (_, index) => `db-${index}`).join(', ');
    expect(mapFailureMessage(failed(12))).toBe(
      `12 resources failed: ${shown}, and ${hidden} more`,
    );
  });

  it('reports one resource that was not started', () => {
    expect(mapFailureMessage([
      outcome('test-db', 'failed'),
      outcome('other-db', 'not-started'),
    ])).toBe('1 resource failed: test-db. 1 resource was not started.');
  });

  it('reports resources that were not started', () => {
    expect(mapFailureMessage([
      outcome('db-a', 'failed'),
      outcome('db-b', 'failed'),
      outcome('db-c', 'not-started'),
      outcome('db-d', 'not-started'),
    ])).toBe('2 resources failed: db-a, db-b. 2 resources were not started.');
  });
});

describe('mapItemOutcomes', () => {
  it.each([
    {
      name: 'a missing index',
      observed: [] as ObservedMapItem[],
      expected: 'not-started' as const,
    },
    {
      name: 'an item still started',
      observed: [{ index: 0, state: 'started' as const }],
      expected: 'not-started' as const,
    },
    {
      name: 'a failed item',
      observed: [{ index: 0, state: 'failed' as const }],
      expected: 'failed' as const,
    },
    {
      name: 'a succeeded item',
      observed: [{ index: 0, state: 'succeeded' as const }],
      expected: 'succeeded' as const,
    },
  ])('records $expected for $name', ({ observed, expected }) => {
    expect(mapItemOutcomes(['test-db'], observed)).toEqual([{ name: 'test-db', state: expected }]);
  });

  it('keeps input order when later indexes are missing', () => {
    expect(mapItemOutcomes(['db-a', 'db-b', 'db-c'], [
      { index: 2, state: 'succeeded' },
      { index: 0, state: 'failed' },
    ])).toEqual([
      { name: 'db-a', state: 'failed' },
      { name: 'db-b', state: 'not-started' },
      { name: 'db-c', state: 'succeeded' },
    ]);
  });
});
