import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const fixture = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (fixture.schemaVersion !== 1 || !Number.isFinite(Date.parse(fixture.now))) throw new Error('Invalid golden fixture');
const OriginalDate = Date;
const instant = Date.parse(fixture.now);
globalThis.Date = class extends OriginalDate {
  constructor(...args) { super(...(args.length ? args : [instant])); }
  static now() { return instant; }
};
// Isolation is process-local. No real provider endpoints, credentials, hooks,
// owner PID, or parser discovery are involved in this contract capture.
globalThis.fetch = () => { throw new Error('Golden capture attempted network access'); };
process.env.TZ = 'UTC';
const dir = await mkdtemp(join(tmpdir(), 'jusage-golden-'));
process.env.JUSAGE_CONFIG_HOME = join(dir, 'identity');
process.env.TUD_DATA_DIR = dir;
try {
  const core = await import(process.env.TUD_GOLDEN_CORE_PATH ? pathToFileURL(process.env.TUD_GOLDEN_CORE_PATH).href : '@juejin-opensource/jusage-core');
  const { buildReadSnapshot } = await import(process.env.TUD_GOLDEN_SNAPSHOT_PATH ? pathToFileURL(process.env.TUD_GOLDEN_SNAPSHOT_PATH).href : '../../dist/host/read-snapshot.js');
  core.applyRemotePricingOverlay(fixture.pricing);
  const { config } = await core.loadConfig(dir);
  config.deviceId = 'golden-device';
  config.statsSince = fixture.statsSince;
  config.localCollectSince = fixture.statsSince;
  config.juejin.enabled = false;
  config.juejin.token = null;
  const endpoints = ['tud-usage-summary', 'tud-account-usage-summary', 'tud-usage-daily', 'tud-usage-hourly', 'tud-usage-model-breakdown'];
  const responses = [], native = [];
  for (const scenario of ['empty', 'mixed', 'collect-floor', 'warm-cache', 'sealed-only', 'pricing-change']) {
    core.applyRemotePricingOverlay(scenario === 'pricing-change' ? {exact:{'fixture-model':{input:4,output:10,cache_read:0.4,cache_write:5}}} : fixture.pricing);
    const rows = scenario === 'empty' ? [] : fixture.rows;
    const scenarioConfig = { ...config, localCollectSince: scenario === 'collect-floor' ? '2026-10-28T00:00:00.000Z' : fixture.statsSince };
    const store = new core.BucketStore(); store.apply(rows);
    const cache = new core.AggregateCache(join(dir, scenario));
    await cache.rebuildFromRows(rows);
    const actualCache = scenario === 'warm-cache' ? new core.AggregateCache(join(dir, scenario)) : cache;
    await actualCache.ensureLoaded();
    if (scenario === 'sealed-only') {
      // Persisted closed days remain authoritative even if hot rows contain
      // only today. A Rust implementation that merely scans queue rows fails.
      await core.appendBuckets(join(dir,scenario), rows.filter(row=>core.localDateAndHour(row.hour_start).date===core.localDateNow()));
      await store.reload(join(dir,scenario),fixture.statsSince);
    }
    const app = core.createLocalApiApp({ dataDir: dir, getConfig: () => scenarioConfig, bucketStore: store, aggregateCache: actualCache });
    const snapshot = buildReadSnapshot({config:scenarioConfig, bucketStore:store, aggregateCache:actualCache}, 'golden-session');
    for (const endpoint of endpoints) {
      for (const query of endpoint.includes('summary') ? [''] : fixture.queries) {
        const path = `/functions/${endpoint}${query}`;
        const response = await app.request(path);
        const record = { scenario, path, status: response.status, body: await response.json() };
        responses.push(record);
        if (endpoint === 'tud-usage-daily') native.push({ ...record, snapshot, today:snapshot.today });
      }
    }
  }
  // Exercise DST and locale-independent calendar fields with the same binary.
  const calendar = ['Asia/Shanghai', 'America/New_York', 'Europe/Berlin'].map(zone => ({
    zone, values: ['2026-03-08T06:30:00Z', '2026-03-08T07:30:00Z', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z'].map(value => core.localDateAndHour(value, zone)),
  }));
  process.stdout.write(JSON.stringify({ schemaVersion:1, now:fixture.now, responses, calendar, native }));
} finally { await rm(dir, { recursive:true, force:true }); }
