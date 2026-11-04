import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPetPreferenceSaver as tauriSaver } from './pet-preference-saver.ts';
import { createPetPreferenceSaver as electronSaver } from '../../../../apps/desktop/src/renderer/lib/pet-preference-saver.ts';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
for (const [name, createSaver] of [['Tauri', tauriSaver], ['Electron', electronSaver]] as const) {
  test(`${name}: dragging previews locally; only the committed value reaches native code`, async () => {
    const writes: unknown[] = [], applied: unknown[] = [];
    let editing = false;
    const saver = createSaver(async changes => { writes.push(changes); return changes; }, saved => applied.push(saved), reason => assert.fail(String(reason)), () => editing);
    editing = true;
    let preview = 0;
    for (const size of [40, 45, 50, 55, 60]) {
      saver.invalidate();
      assert.equal(saver.busy, true);
      preview = size;
    }
    assert.equal(writes.length, 0);
    editing = false;
    saver.save({ scale: preview / 100 });
    await flush();
    assert.deepEqual(writes, [{ scale: 0.6 }]);
    assert.deepEqual(applied, [{ scale: 0.6 }]);
  });

  test(`${name}: slow responses cannot pull a newly dragged slider backwards`, async () => {
    let editing = false;
    let finish!: (value: { scale: number }) => void;
    const applied: unknown[] = [];
    const saver = createSaver(() => new Promise<{ scale: number }>(resolve => { finish = resolve; }), saved => applied.push(saved), reason => assert.fail(String(reason)), () => editing);
    saver.save({ scale: 0.4 });
    editing = true;
    saver.invalidate();
    finish({ scale: 0.4 });
    await flush();
    assert.deepEqual(applied, []);
    assert.equal(saver.busy, true);
  });

  test(`${name}: rapid commits are serialized and keep the newest size and speed`, async () => {
    const writes: unknown[] = [], applied: unknown[] = [], finishes: ((value: object) => void)[] = [];
    const saver = createSaver(changes => { writes.push(changes); return new Promise<object>(resolve => finishes.push(resolve)); }, saved => applied.push(saved), reason => assert.fail(String(reason)), () => false);
    saver.save({ scale: 0.4 });
    saver.save({ scale: 0.5 });
    saver.save({ scale: 0.65, frameIntervalMs: 120 });
    assert.equal(writes.length, 1);
    finishes[0]({ scale: 0.4 }); await flush();
    assert.deepEqual(applied, []);
    assert.deepEqual(writes, [{ scale: 0.4 }, { scale: 0.65, frameIntervalMs: 120 }]);
    finishes[1]({ scale: 0.65, frameIntervalMs: 120 }); await flush();
    assert.deepEqual(applied, [{ scale: 0.65, frameIntervalMs: 120 }]);
    assert.equal(saver.busy, false);
  });

  test(`${name}: closing the panel preserves pending commits without updating its UI`, async () => {
    const writes: unknown[] = [], applied: unknown[] = [], finishes: ((value: object) => void)[] = [];
    const saver = createSaver(changes => { writes.push(changes); return new Promise<object>(resolve => finishes.push(resolve)); }, saved => applied.push(saved), reason => assert.fail(String(reason)), () => false);
    saver.save({ scale: 0.5 }); saver.save({ frameIntervalMs: 160 });
    saver.setActive(false);
    finishes[0]({}); await flush();
    assert.deepEqual(writes, [{ scale: 0.5 }, { frameIntervalMs: 160 }]);
    finishes[1]({}); await flush();
    assert.deepEqual(applied, []);
    // React StrictMode can reactivate the same effect-owned saver.
    saver.setActive(true); saver.save({ scale: 0.6 });
    finishes[2]({ scale: 0.6 }); await flush();
    assert.deepEqual(applied, [{ scale: 0.6 }]);
  });

  test(`${name}: a failed write reports its error and does not block the next commit`, async () => {
    const errors: unknown[] = [], applied: unknown[] = [];
    let reject!: (reason: unknown) => void;
    let calls = 0;
    const saver = createSaver(changes => ++calls === 1 ? new Promise<object>((_, fail) => { reject = fail; }) : Promise.resolve(changes), saved => applied.push(saved), reason => errors.push(reason), () => false);
    saver.save({ scale: 0.4 }); saver.save({ scale: 0.7 });
    reject('write failed'); await flush();
    assert.deepEqual(errors, ['write failed']);
    assert.deepEqual(applied, [{ scale: 0.7 }]);
    assert.equal(saver.busy, false);
  });
}
