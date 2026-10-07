import {
  decideResourceAction,
  hasWaitBudget,
  MAX_WAIT_SECONDS_LIMIT,
  nextWaitStep,
  resolveResourceWait,
  shouldContinueWaitLoop,
  TRANSITIONING_STATES,
} from '../src/funcs/running-schedule-wait';

describe('decideResourceAction', () => {
  it.each([
    { mode: 'Start' as const, current: 'not-found', expected: 'not-found' },
    { mode: 'Stop' as const, current: 'not-found', expected: 'not-found' },
    { mode: 'Start' as const, current: 'available', expected: 'done' },
    { mode: 'Stop' as const, current: 'stopped', expected: 'done' },
    { mode: 'Start' as const, current: 'stopped', expected: 'start' },
    { mode: 'Stop' as const, current: 'available', expected: 'stop' },
    { mode: 'Start' as const, current: 'incompatible-restore', expected: 'unexpected' },
    { mode: 'Stop' as const, current: 'incompatible-parameters', expected: 'unexpected' },
  ])('returns $expected for $mode when status is $current', ({ mode, current, expected }) => {
    expect(decideResourceAction(mode, current)).toBe(expected);
  });

  it.each(TRANSITIONING_STATES)('waits while Start sees %s', (current) => {
    expect(decideResourceAction('Start', current)).toBe('wait');
  });

  it.each(TRANSITIONING_STATES)('waits while Stop sees %s', (current) => {
    expect(decideResourceAction('Stop', current)).toBe('wait');
  });
});

describe('hasWaitBudget', () => {
  it.each([
    { elapsed: 0, interval: 60, max: 60, expected: true },
    { elapsed: 0, interval: 60, max: 1800, expected: true },
    { elapsed: 1740, interval: 60, max: 1800, expected: true },
    { elapsed: 60, interval: 60, max: 60, expected: false },
    { elapsed: 1800, interval: 60, max: 1800, expected: false },
    { elapsed: 120, interval: 30, max: 100, expected: false },
  ])(
    'elapsed $elapsed + interval $interval against max $max is $expected',
    ({ elapsed, interval, max, expected }) => {
      expect(hasWaitBudget(elapsed, interval, max)).toBe(expected);
    },
  );
});

describe('nextWaitStep', () => {
  it.each([
    {
      name: 'skips a missing resource even when the budget is exhausted',
      mode: 'Start' as const,
      current: 'not-found',
      elapsed: 1800,
      interval: 60,
      max: 1800,
      expected: { kind: 'finish', status: 'skipped' },
    },
    {
      name: 'finishes when Start already sees available',
      mode: 'Start' as const,
      current: 'available',
      elapsed: 0,
      interval: 60,
      max: 1800,
      expected: { kind: 'finish', status: 'available' },
    },
    {
      name: 'finishes when Stop already sees stopped',
      mode: 'Stop' as const,
      current: 'stopped',
      elapsed: 0,
      interval: 60,
      max: 1800,
      expected: { kind: 'finish', status: 'stopped' },
    },
    {
      name: 'starts a stopped DB while budget remains',
      mode: 'Start' as const,
      current: 'stopped',
      elapsed: 0,
      interval: 60,
      max: 1800,
      expected: { kind: 'pause', command: 'start' },
    },
    {
      name: 'stops an available DB while budget remains',
      mode: 'Stop' as const,
      current: 'available',
      elapsed: 0,
      interval: 60,
      max: 1800,
      expected: { kind: 'pause', command: 'stop' },
    },
    {
      name: 'pauses without a command while the resource is transitioning',
      mode: 'Start' as const,
      current: 'starting',
      elapsed: 60,
      interval: 60,
      max: 1800,
      expected: { kind: 'pause', command: 'none' },
    },
    {
      name: 'times out when the next interval would exceed the maximum',
      mode: 'Start' as const,
      current: 'starting',
      elapsed: 60,
      interval: 60,
      max: 60,
      expected: { kind: 'timed-out' },
    },
    {
      name: 'times out a stopped resource when no budget remains for start',
      mode: 'Start' as const,
      current: 'stopped',
      elapsed: 120,
      interval: 60,
      max: 120,
      expected: { kind: 'timed-out' },
    },
    {
      name: 'fails on an unexpected status',
      mode: 'Stop' as const,
      current: 'incompatible-restore',
      elapsed: 0,
      interval: 60,
      max: 1800,
      expected: { kind: 'fail', current: 'incompatible-restore' },
    },
  ])('$name', ({ mode, current, elapsed, interval, max, expected }) => {
    expect(nextWaitStep(mode, current, elapsed, interval, max)).toEqual(expected);
  });
});

describe('shouldContinueWaitLoop', () => {
  it.each([
    { signal: 'open' as const, expected: true },
    { signal: 'settled' as const, expected: false },
    { signal: 'failed' as const, expected: false },
  ])('returns $expected when the signal is $signal', ({ signal, expected }) => {
    expect(shouldContinueWaitLoop(signal)).toBe(expected);
  });
});

describe('resolveResourceWait', () => {
  it('accepts the maximum allowed wait', () => {
    expect(resolveResourceWait(60, MAX_WAIT_SECONDS_LIMIT)).toEqual({
      intervalSeconds: 60,
      maxSeconds: MAX_WAIT_SECONDS_LIMIT,
    });
  });

  it('accepts a maximum equal to the interval', () => {
    expect(resolveResourceWait(30, 30)).toEqual({
      intervalSeconds: 30,
      maxSeconds: 30,
    });
  });

  it.each([
    { interval: 0, max: 1800, message: 'resourceWait.intervalSeconds must be a positive integer' },
    { interval: 1.5, max: 1800, message: 'resourceWait.intervalSeconds must be a positive integer' },
    { interval: -1, max: 1800, message: 'resourceWait.intervalSeconds must be a positive integer' },
    { interval: 60, max: 0, message: 'resourceWait.maxSeconds must be a positive integer' },
    { interval: 60, max: 1.2, message: 'resourceWait.maxSeconds must be a positive integer' },
    {
      interval: 120,
      max: 60,
      message: 'resourceWait.maxSeconds must be greater than or equal to resourceWait.intervalSeconds',
    },
    {
      interval: 60,
      max: MAX_WAIT_SECONDS_LIMIT + 1,
      message: `resourceWait.maxSeconds must be less than or equal to ${MAX_WAIT_SECONDS_LIMIT}`,
    },
  ])('rejects interval $interval and max $max', ({ interval, max, message }) => {
    expect(() => resolveResourceWait(interval, max)).toThrow(message);
  });
});
