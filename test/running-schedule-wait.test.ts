import {
  RdsDatabaseRunningSchedulerStatusError,
  RdsDatabaseRunningSchedulerTimeoutError,
  RdsDatabaseRunningSchedulerValidateError,
} from '../src/funcs/core/running-schedule-errors';
import {
  BACKING_UP_STATUS,
  decideResourceAction,
  hasWaitBudget,
  nextWaitStep,
  resolveResourceWait,
  shouldContinueWaitLoop,
  STOP_REQUEST,
  TRANSITIONING_STATES,
  type NextWaitStepOptions,
  type StopRequest,
} from '../src/funcs/core/running-schedule-wait';
import { MAX_WAIT_SECONDS_LIMIT } from '../src/settings/consts';

const waitOptions = (overrides: Partial<NextWaitStepOptions> = {}): NextWaitStepOptions => ({
  mode: 'Start',
  current: 'available',
  elapsedWaitSeconds: 0,
  intervalSeconds: 60,
  maxWaitSeconds: 1800,
  resourceLabel: 'type=db identifier=test-db',
  type: 'db',
  identifier: 'test-db',
  stopRequest: STOP_REQUEST.NOT_SENT,
  ...overrides,
});

const observe = (
  mode: 'Start' | 'Stop',
  current: string,
  stopRequest: StopRequest = STOP_REQUEST.NOT_SENT,
) => ({ mode, current, stopRequest });

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
    expect(decideResourceAction(observe(mode, current))).toBe(expected);
  });

  it.each(TRANSITIONING_STATES)('waits while Start sees %s', (current) => {
    expect(decideResourceAction(observe('Start', current))).toBe('wait');
  });

  it.each(TRANSITIONING_STATES.filter((state) => state !== BACKING_UP_STATUS))(
    'waits while Stop sees %s before a stop is sent',
    (current) => {
      expect(decideResourceAction(observe('Stop', current))).toBe('wait');
    },
  );

  it('defers a stop that has not been sent while the database is backing up', () => {
    expect(decideResourceAction(observe('Stop', BACKING_UP_STATUS))).toBe('defer');
  });

  it('waits after a stop was sent while the database is backing up', () => {
    expect(decideResourceAction(observe('Stop', BACKING_UP_STATUS, STOP_REQUEST.SENT))).toBe('wait');
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
      name: 'waits without starting while Start sees storage-optimization',
      mode: 'Start' as const,
      current: 'storage-optimization',
      elapsed: 0,
      interval: 60,
      max: 1800,
      expected: { kind: 'pause', command: 'none' },
    },
    {
      name: 'waits without failing while Stop sees storage-optimization',
      mode: 'Stop' as const,
      current: 'storage-optimization',
      elapsed: 0,
      interval: 60,
      max: 1800,
      expected: { kind: 'pause', command: 'none' },
    },
    {
      name: 'defers a stop during backup even when the budget is exhausted',
      mode: 'Stop' as const,
      current: BACKING_UP_STATUS,
      elapsed: 1800,
      interval: 60,
      max: 1800,
      expected: {
        kind: 'finish',
        status: 'deferred',
        reason: 'Stop deferred for DB test-db: status is backing-up. The next stop schedule will try again.',
      },
    },
  ])('$name', ({ mode, current, elapsed, interval, max, expected }) => {
    expect(nextWaitStep(waitOptions({
      mode,
      current,
      elapsedWaitSeconds: elapsed,
      intervalSeconds: interval,
      maxWaitSeconds: max,
    }))).toEqual(expected);
  });

  it.each([
    {
      name: 'the next interval would exceed the maximum',
      mode: 'Start' as const,
      current: 'starting',
      elapsed: 60,
      max: 60,
    },
    {
      name: 'no budget remains to start a stopped resource',
      mode: 'Start' as const,
      current: 'stopped',
      elapsed: 120,
      max: 120,
    },
    {
      name: 'no budget remains while Stop sees storage-optimization',
      mode: 'Stop' as const,
      current: 'storage-optimization',
      elapsed: 1800,
      max: 1800,
    },
    {
      name: 'a stop was already sent and backup continues past the budget',
      mode: 'Stop' as const,
      current: BACKING_UP_STATUS,
      elapsed: 1800,
      max: 1800,
      stopRequest: STOP_REQUEST.SENT,
    },
  ])('throws a timeout error when $name', ({ mode, current, elapsed, max, stopRequest }) => {
    const act = () => nextWaitStep(waitOptions({
      mode,
      current,
      elapsedWaitSeconds: elapsed,
      maxWaitSeconds: max,
      ...(stopRequest === undefined ? {} : { stopRequest }),
    }));

    expect(act).toThrow(RdsDatabaseRunningSchedulerTimeoutError);
    expect(act).toThrow(`wait timed out: type=db identifier=test-db maxWaitSeconds=${max}`);
  });

  it.each([
    { mode: 'Stop' as const, current: 'incompatible-restore' },
    { mode: 'Start' as const, current: 'incompatible-parameters' },
  ])('throws a status error when $mode sees $current', ({ mode, current }) => {
    const act = () => nextWaitStep(waitOptions({ mode, current }));

    expect(act).toThrow(RdsDatabaseRunningSchedulerStatusError);
    expect(act).toThrow(`db instance or cluster status fail: type=db identifier=test-db current=${current}`);
  });

  it('defers a cluster stop during backup', () => {
    expect(nextWaitStep(waitOptions({
      mode: 'Stop',
      current: BACKING_UP_STATUS,
      type: 'cluster',
      identifier: 'test-cluster',
    }))).toEqual({
      kind: 'finish',
      status: 'deferred',
      reason: 'Stop deferred for cluster test-cluster: status is backing-up. The next stop schedule will try again.',
    });
  });

  it('waits after a stop was sent while the database is backing up', () => {
    expect(nextWaitStep(waitOptions({
      mode: 'Stop',
      current: BACKING_UP_STATUS,
      stopRequest: STOP_REQUEST.SENT,
    }))).toEqual({ kind: 'pause', command: 'none' });
  });

  it('reports an unexpected status before the wait budget is checked', () => {
    const act = () => nextWaitStep(waitOptions({
      mode: 'Stop',
      current: 'incompatible-restore',
      elapsedWaitSeconds: 1800,
      maxWaitSeconds: 1800,
    }));

    expect(act).toThrow(RdsDatabaseRunningSchedulerStatusError);
  });
});

describe('shouldContinueWaitLoop', () => {
  it.each([
    { signal: 'open' as const, expected: true },
    { signal: 'settled' as const, expected: false },
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
    expect(() => resolveResourceWait(interval, max)).toThrow(RdsDatabaseRunningSchedulerValidateError);
    expect(() => resolveResourceWait(interval, max)).toThrow(message);
  });
});
