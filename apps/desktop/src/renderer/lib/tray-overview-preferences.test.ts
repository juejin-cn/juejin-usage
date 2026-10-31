import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TRAY_OVERVIEW_MODULES,
  TRAY_OVERVIEW_STORAGE_KEY,
  defaultTrayOverviewVisibility,
  readTrayOverviewVisibility,
  writeTrayOverviewVisibility,
  type TrayOverviewStorage,
} from './tray-overview-preferences';

function memoryStorage(initial: string | null = null): TrayOverviewStorage {
  let value = initial;
  return {
    getItem(key) {
      assert.equal(key, TRAY_OVERVIEW_STORAGE_KEY);
      return value;
    },
    setItem(key, next) {
      assert.equal(key, TRAY_OVERVIEW_STORAGE_KEY);
      value = next;
    },
  };
}

test('new installations show every module and defaults are independent objects', () => {
  const defaults = defaultTrayOverviewVisibility();
  assert.equal(Object.keys(defaults).length, 8);
  assert.ok(Object.values(defaults).every(Boolean));
  assert.deepEqual(readTrayOverviewVisibility(memoryStorage()), defaults);
  defaults.cost = false;
  assert.equal(defaultTrayOverviewVisibility().cost, true);
});

test('individual choices and all-hidden choices survive reload; defaults restore all', () => {
  const storage = memoryStorage();
  const visibility = defaultTrayOverviewVisibility();
  visibility.cost = false;
  visibility.tools = false;
  assert.equal(writeTrayOverviewVisibility(visibility, storage), true);
  assert.deepEqual(readTrayOverviewVisibility(storage), visibility);
  for (const { id } of TRAY_OVERVIEW_MODULES) visibility[id] = false;
  assert.equal(writeTrayOverviewVisibility(visibility, storage), true);
  assert.deepEqual(readTrayOverviewVisibility(storage), visibility);
  assert.equal(writeTrayOverviewVisibility(defaultTrayOverviewVisibility(), storage), true);
  assert.deepEqual(readTrayOverviewVisibility(storage), defaultTrayOverviewVisibility());
});

test('version 1 saves accept boolean choices and default new or invalid keys to visible', () => {
  const visibility = readTrayOverviewVisibility(memoryStorage(JSON.stringify({
    version: 1,
    visibility: { cost: false, subscriptions: false, totalTokens: 'false', tools: 0, unknown: false },
  })));
  assert.deepEqual(visibility, {
    ...defaultTrayOverviewVisibility(), cost: false, subscriptions: false,
  });
  assert.equal('unknown' in visibility, false);
});

test('malformed, unversioned and unsupported versions safely use defaults', () => {
  for (const saved of ['{', 'null', '[]', '42', '{}',
    '{"version":1,"visibility":null}', '{"version":1,"visibility":[]}',
    '{"visibility":{"cost":false}}', '{"version":2,"visibility":{"cost":false}}',
    '{"version":"1","visibility":{"cost":false}}']) {
    assert.deepEqual(readTrayOverviewVisibility(memoryStorage(saved)), defaultTrayOverviewVisibility(), saved);
  }
});

test('unavailable storage is nonfatal and failed writes are reported', () => {
  const inaccessible: TrayOverviewStorage = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
  };
  assert.deepEqual(readTrayOverviewVisibility(inaccessible), defaultTrayOverviewVisibility());
  assert.equal(writeTrayOverviewVisibility(defaultTrayOverviewVisibility(), inaccessible), false);
  assert.deepEqual(readTrayOverviewVisibility(null), defaultTrayOverviewVisibility());
  assert.equal(writeTrayOverviewVisibility(defaultTrayOverviewVisibility(), null), false);
  assert.deepEqual(readTrayOverviewVisibility(), defaultTrayOverviewVisibility());
});

test('a denied localStorage getter is handled before reading or writing', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { get localStorage() { throw new Error('SecurityError'); } },
  });
  try {
    assert.deepEqual(readTrayOverviewVisibility(), defaultTrayOverviewVisibility());
    assert.equal(writeTrayOverviewVisibility(defaultTrayOverviewVisibility()), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
