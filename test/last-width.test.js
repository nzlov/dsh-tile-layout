import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSizingStore, defaultSessionWidth, LAYOUT_KEY, parseSizing,
  resizeSessionWidth, retainSessionWidths, sessionStrip,
} from '../src/layout.js';

const empty = () => ({ columns: {}, rows: {}, spans: {} });
const fixed = (paneWidths, lastWidth) => ({
  ...empty(), paneWidths: { ...paneWidths },
  ...(lastWidth === undefined ? {} : { lastWidth }),
});
function fixture() {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  const change = (events, key = LAYOUT_KEY, storageArea = storage) => {
    events.dispatchEvent(Object.assign(new Event('storage'), { key, storageArea }));
  };
  return { storage, change };
}

test('before a manual resize new cards use 380, and a saved last width overrides ratio-only projection', () => {
  assert.deepEqual(parseSizing(null), empty());
  assert.equal(defaultSessionWidth(parseSizing(null)), 380);
  const first = retainSessionWidths(parseSizing(null), [], 8000);
  assert.deepEqual(sessionStrip(first, ['new'], 8000).widths, [380]);
  const lastOnly = { columns: { 2: [0.9, 0.1] }, rows: {}, spans: { 2: 3000 }, lastWidth: 660 };
  assert.equal(Object.hasOwn(lastOnly, 'paneWidths'), false);
  for (const viewport of [500, 8000]) {
    assert.deepEqual(sessionStrip(lastOnly, ['a', 'b'], viewport).widths, [660, 660]);
  }
});

test('newly created or chosen cards inherit the last manually resized card width', () => {
  const initial = fixed({ a: 380 });
  const resized = resizeSessionWidth(initial, ['a'], 2000, 'a', 240);
  assert.equal(resized.paneWidths.a, 620);
  assert.equal(defaultSessionWidth(resized), 620);
  assert.equal(resized.lastWidth, 620);
  for (const added of ['created', 'chosen']) {
    const order = [added, 'a'];
    assert.deepEqual(sessionStrip(resized, order, 2000).widths, [620, 620]);
    const retained = retainSessionWidths(resized, order, 2000);
    assert.equal(retained.paneWidths[added], 620);
    assert.equal(retained.lastWidth, 620);
  }
  assert.equal(initial.paneWidths.a, 380);
  assert.equal(Object.hasOwn(initial, 'lastWidth'), false);
});

test('resizing another card updates the default but preserves remembered widths through remove, rejoin and reorder', () => {
  const initial = fixed({ a: 620, b: 480, removed: 770 }, 620);
  const changed = resizeSessionWidth(initial, ['a', 'b'], 2000, 'b', 75);
  assert.equal(defaultSessionWidth(changed), 555);
  const joined = retainSessionWidths(changed, ['new', 'a', 'b'], 2000);
  assert.strictEqual(retainSessionWidths(joined, ['b'], 500), joined);
  assert.deepEqual(sessionStrip(joined, ['removed', 'new', 'b', 'a'], 5000).widths, [770, 555, 555, 620]);
  const changedAgain = resizeSessionWidth(joined, ['a', 'b', 'new'], 2000, 'a', 90);
  assert.equal(defaultSessionWidth(changedAgain), 710);
  assert.deepEqual(sessionStrip(changedAgain, ['another', 'new', 'removed', 'b', 'a'], 5000).widths,
    [710, 555, 770, 555, 710]);
});

test('automatic width initialization never creates or changes the last manual width', () => {
  const untouched = retainSessionWidths(parseSizing(null), [], 2000);
  const initialized = retainSessionWidths(untouched, ['first'], 2000);
  assert.equal(initialized.paneWidths.first, 380);
  assert.equal(Object.hasOwn(initialized, 'lastWidth'), false);
  const lastOnly = { ...empty(), lastWidth: 655.5 };
  const projected = retainSessionWidths(lastOnly, ['a', 'b'], 8000);
  assert.deepEqual({ ...projected.paneWidths }, { a: 655.5, b: 655.5 });
  assert.equal(projected.lastWidth, 655.5);
  const remembered = retainSessionWidths(fixed({ a: 420 }, 655.5), ['new', 'a'], 8000);
  assert.deepEqual({ ...remembered.paneWidths }, { a: 420, new: 655.5 });
  assert.equal(remembered.lastWidth, 655.5);
});

test('save, refresh, storage events and delayed cross-tab sync retain the last manual width', t => {
  const { storage, change } = fixture();
  const writerEvents = new EventTarget();
  const writer = createSizingStore(() => storage, writerEvents);
  const reader = createSizingStore(() => storage, new EventTarget());
  const stores = [writer, reader];
  t.after(() => stores.forEach(store => store.dispose()));
  const manual = resizeSessionWidth(fixed({ a: 380 }), ['a'], 2000, 'a', 270);
  writer.save(manual);
  assert.equal(defaultSessionWidth(reader.getSnapshot().sizing), 380);
  reader.sync();
  assert.equal(defaultSessionWidth(reader.getSnapshot().sizing), 650);
  const refreshed = createSizingStore(() => storage, new EventTarget()); stores.push(refreshed);
  assert.equal(refreshed.getSnapshot().sizing.lastWidth, 650);
  assert.deepEqual(sessionStrip(refreshed.getSnapshot().sizing, ['new', 'a'], 5000).widths, [650, 650]);
  storage.setItem(LAYOUT_KEY, JSON.stringify(fixed({ a: 725 }, 725)));
  const before = writer.getSnapshot();
  change(writerEvents, 'unrelated'); change(writerEvents, LAYOUT_KEY, {});
  assert.strictEqual(writer.getSnapshot(), before);
  change(writerEvents);
  assert.equal(writer.getSnapshot().sizing.lastWidth, 725);
  reader.sync(); refreshed.sync();
  assert.equal(reader.getSnapshot().sizing.lastWidth, 725);
  assert.equal(refreshed.getSnapshot().sizing.lastWidth, 725);
  const synced = reader.getSnapshot(); reader.sync();
  assert.strictEqual(reader.getSnapshot(), synced);
});

test('default and parsed last widths clamp finite own data values and ignore invalid, inherited or accessor values', () => {
  for (const value of [-100, 0, 339, 340, 500.25, 10000, 1e8]) {
    const expected = Math.max(340, Math.min(10000, value));
    assert.equal(defaultSessionWidth({ lastWidth: value }), expected);
    assert.deepEqual(parseSizing(JSON.stringify({ lastWidth: value })), { ...empty(), lastWidth: expected });
  }
  for (const value of [undefined, null, NaN, Infinity, -Infinity, '650', false, {}, []]) {
    assert.equal(defaultSessionWidth({ lastWidth: value }), 380);
    const parsed = parseSizing(JSON.stringify({ lastWidth: value }));
    assert.deepEqual(parsed, empty());
    assert.equal(Object.hasOwn(parsed, 'lastWidth'), false);
  }
  assert.equal(defaultSessionWidth(Object.create({ lastWidth: 900 })), 380);
  let reads = 0;
  const accessor = Object.defineProperty(fixed({}), 'lastWidth', {
    enumerable: true,
    get() { reads++; throw new Error('last width accessor must not run'); },
  });
  assert.equal(defaultSessionWidth(accessor), 380);
  assert.deepEqual(sessionStrip(accessor, ['new'], 2000).widths, [380]);
  assert.equal(defaultSessionWidth(Object.create(accessor)), 380);
  assert.equal(reads, 0);
});

test('zero, invalid and clamped motion preserve object identity and do not update the last width', () => {
  const sizing = Object.freeze({ ...empty(), paneWidths: Object.freeze({ a: 340, b: 10000 }), lastWidth: 555 });
  for (const delta of [0, NaN, Infinity, -Infinity, '10', null]) {
    assert.strictEqual(resizeSessionWidth(sizing, ['a', 'b'], 2000, 'a', delta), sizing);
  }
  assert.strictEqual(resizeSessionWidth(sizing, ['a', 'b', 'unknown'], 2000, 'a', -1), sizing);
  assert.strictEqual(resizeSessionWidth(sizing, ['a', 'b'], 2000, 'b', 1), sizing);
  assert.strictEqual(resizeSessionWidth(sizing, ['a', 'b'], 2000, 'missing', 40), sizing);
  assert.strictEqual(resizeSessionWidth(sizing, ['constructor'], 2000, 'constructor', 40), sizing);
  assert.equal(sizing.lastWidth, 555);
  assert.equal(Object.hasOwn(sizing.paneWidths, 'unknown'), false);
  const untouched = fixed({ a: 380 });
  assert.strictEqual(resizeSessionWidth(untouched, ['a'], 2000, 'a', 0), untouched);
  assert.equal(Object.hasOwn(untouched, 'lastWidth'), false);
});

test('a resize preview remains unpersisted until the final candidate is explicitly saved', t => {
  const { storage } = fixture();
  const store = createSizingStore(() => storage, new EventTarget());
  t.after(() => store.dispose());
  const baseline = fixed({ a: 500 }, 500);
  store.save(baseline);
  const saved = storage.getItem(LAYOUT_KEY);
  const preview = resizeSessionWidth(baseline, ['a'], 2000, 'a', 120);
  assert.equal(preview.lastWidth, 620);
  assert.equal(preview.paneWidths.a, 620);
  assert.strictEqual(store.getSnapshot().sizing, baseline);
  assert.equal(storage.getItem(LAYOUT_KEY), saved);
  assert.equal(defaultSessionWidth(store.getSnapshot().sizing), 500);
  const committed = resizeSessionWidth(baseline, ['a'], 2000, 'a', 180);
  store.save(committed);
  assert.equal(JSON.parse(storage.getItem(LAYOUT_KEY)).lastWidth, 680);
  assert.deepEqual(sessionStrip(store.getSnapshot().sizing, ['next', 'a'], 5000).widths, [680, 680]);
});

test('resetting a resized card to 380 makes 380 the persisted default without changing its neighbor', t => {
  const { storage } = fixture();
  const store = createSizingStore(() => storage, new EventTarget());
  const stores = [store]; t.after(() => stores.forEach(item => item.dispose()));
  const initial = fixed({ a: 640, b: 700 }, 700);
  const reset = resizeSessionWidth(initial, ['a', 'b'], 2000, 'a', 380 - initial.paneWidths.a);
  store.save(reset);
  assert.equal(reset.lastWidth, 380);
  assert.deepEqual(sessionStrip(reset, ['new', 'a', 'b'], 5000).widths, [380, 380, 700]);
  const refreshed = createSizingStore(() => storage, new EventTarget()); stores.push(refreshed);
  assert.equal(defaultSessionWidth(refreshed.getSnapshot().sizing), 380);
  assert.equal(refreshed.getSnapshot().sizing.paneWidths.b, 700);
});
