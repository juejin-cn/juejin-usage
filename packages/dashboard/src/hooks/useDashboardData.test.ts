import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Execute both real hooks with controllable effects and requests. No browser or
// real runtime/data directory is involved in these lifecycle regressions.
for (const file of [
  new URL('./useDashboardData.ts', import.meta.url),
  new URL('../../../../apps/desktop/src/renderer/hooks/useDashboardData.ts', import.meta.url),
]) {
  for (const warmB of [false, true]) {
  test(`${file.pathname} (B cached: ${warmB}): cached A → pending B → A restores idle and polling`, async () => {
    const slots: unknown[] = [];
    let cursor = 0;
    const effects: Array<() => void | (() => void)> = [];
    const listeners = new Map<string, () => void>();
    const timers = new Map<number, () => void>();
    let timerId = 0;
    const empty = {};
    let revision = 0;
    let calls = 0;
    let resolvePending!: (value: unknown) => void;
    let pending = false;
    const dataset = { dailyRows: [{}], syncStatus: { lastSyncAt: 'first' } };
    const fetchDataset = () => {
      calls++;
      return pending ? new Promise(resolve => { resolvePending = resolve; }) : Promise.resolve(dataset);
    };
    const react = {
      startTransition: (fn: () => void) => fn(),
      useCallback: (fn: unknown) => fn,
      useRef: (initial: unknown) => {
        const index = cursor++;
        return slots[index] ??= { current: initial };
      },
      useState: (initial: unknown) => {
        const index = cursor++;
        if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
        return [slots[index], (value: unknown) => {
          slots[index] = typeof value === 'function' ? value(slots[index]) : value;
          if (index === 0) revision++;
        }];
      },
      useEffect: (fn: () => void | (() => void)) => effects.push(fn),
    };
    const modules: Record<string, unknown> = {
      react,
      '@/hooks/JuejinAuthContext': { useJuejinAuth: () => ({ authStatus: 'authenticated' }) },
      '@/lib/api': {
        isCliBackend: () => true,
        ensureLocalRange: async () => {},
        fetchUsageDataset: fetchDataset,
        fetchUsageDatasetThin: fetchDataset,
        fetchSyncStatus: async () => ({ lastSyncAt: 'changed' }),
      },
      '@/lib/dashboard-data': {
        withClippedTodayHourly: (v: unknown) => v,
        buildDashboardDataFromDataset: (_: unknown, range: number) => ({ range }),
        stabilizeDashboardData: (_: unknown, next: unknown) => next,
      },
      '@/lib/dashboard-fetch-days': {
        resolveDashboardFetchDays: (range: number) => ({ dailyDays: 365, hourlyDays: range, breakdownDays: range }),
      },
      '@/lib/dashboard-mock-data': { emptyDashboardData: empty },
      '@/lib/env': { isMockDataEnabled: () => false },
      '@/lib/usage-dataset-fingerprint': { fingerprintUsageDataset: (_: unknown, range: number) => String(range) },
    };
    const exports: Record<string, (range: number) => { refreshing: boolean; loading: boolean; data: { range?: number } }> = {};
    runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, {
      exports,
      require: (name: string) => {
        if (!(name in modules)) throw new Error(`Unexpected dependency ${name}`);
        return modules[name];
      },
      setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId; },
      clearTimeout: (id: number) => timers.delete(id),
      window: {
        setInterval: (fn: () => void) => { listeners.set('poll', fn); return 1; },
        clearInterval: () => {},
        addEventListener: (key: string, fn: () => void) => listeners.set(key, fn),
        removeEventListener: () => {},
      },
      document: {
        visibilityState: 'visible',
        addEventListener: (key: string, fn: () => void) => listeners.set(key, fn),
        removeEventListener: () => {},
      },
    });
    let cleanup: (() => void) | void = undefined;
    const render = (range: number, commit = true) => {
      cursor = 0; effects.length = 0;
      const result = exports.useDashboardData(range);
      if (commit) { cleanup?.(); cleanup = effects[0](); }
      return result;
    };
    const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
    const runTimers = async () => {
      const callbacks = [...timers.values()]; timers.clear();
      callbacks.forEach(fn => fn()); await flush();
    };
    render(90); effects[1](); await runTimers();
    assert.equal(render(90, false).data.range, 90);
    if (warmB) {
      render(7); await runTimers();
      render(90); await runTimers();
    }
    pending = true;
    render(7); await runTimers();
    assert.equal(render(7, false).refreshing, !(warmB && file.pathname.includes('/apps/desktop/')));
    render(90); await flush();
    assert.equal(render(90, false).refreshing, false);
    resolvePending(dataset); await flush();
    assert.equal(render(90, false).data.range, 90);
    assert.equal(render(90, false).loading, false);
    for (const event of ['poll', 'focus', 'visibilitychange']) {
      const before = revision;
      listeners.get(event)!(); await flush();
      assert.ok(revision > before, `${event} must be able to refresh again`);
    }
    const before = calls;
    render(7); render(30); render(90); await runTimers();
    assert.equal(calls, before, 'cancel superseded tab timers before issuing requests');
  });
  }
}
