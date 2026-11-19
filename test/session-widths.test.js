import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSizingStore, DEFAULT_OVERFLOW_WIDTH, LAYOUT_KEY, MIN_TILE_WIDTH, parseSizing,
  resizeSessionWidth, retainSessionWidths, sessionStrip, TILE_GAP,
} from '../src/layout.js';

const legacy = () => ({ columns: { 2: [0.6, 0.4] }, rows: {}, spans: {} });
const approx = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((width, index) => assert.ok(Math.abs(width - expected[index]) < 1e-7,
    `width ${index}: ${width} versus ${expected[index]}`));
};

function fixture() {
  const values = new Map();
  const events = new EventTarget();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const change = (key, storageArea = storage) => events.dispatchEvent(Object.assign(new Event('storage'), { key, storageArea }));
  return { values, events, storage, change };
}

test('2 → 3 prepend or choose → 2 preserves both existing pixel widths', () => {
  for (const expanded of [['new', 'a', 'b'], ['a', 'b', 'new']]) {
    const initial = legacy();
    const before = sessionStrip(initial, ['a', 'b'], 1500).widths;
    const frozen = retainSessionWidths(initial, ['a', 'b'], 1500);
    const three = sessionStrip(frozen, expanded, 1500);
    approx(three.widths, expanded.map(id => id === 'new' ? DEFAULT_OVERFLOW_WIDTH : before[id === 'a' ? 0 : 1]));
    assert.equal(three.scrolls, true);
    const remembered = retainSessionWidths(frozen, expanded, 1500);
    approx(sessionStrip(remembered, ['a', 'b'], 1500).widths, before);
    assert.equal(remembered.paneWidths.new, DEFAULT_OVERFLOW_WIDTH);
    assert.equal(sessionStrip(remembered, ['a', 'b'], 1500).scrolls, false);
  }
});

test('remove, re-add and reorder use session identity rather than count or position', () => {
  let sizing = retainSessionWidths(legacy(), ['a', 'b'], 1500);
  sizing = resizeSessionWidth(sizing, ['a', 'b'], 1500, 'a', 74);
  const before = sessionStrip(sizing, ['a', 'b'], 1500).widths;
  assert.strictEqual(retainSessionWidths(sizing, ['b'], 1500), sizing);
  approx(sessionStrip(sizing, ['b'], 1500).widths, [before[1]]);
  approx(sessionStrip(sizing, ['b', 'a'], 1500).widths, [before[1], before[0]]);
  approx(sessionStrip(sizing, ['a', 'b'], 1500).widths, before);
  assert.strictEqual(retainSessionWidths(sizing, ['a', 'b'], 1500), sizing);
});

test('viewport changes do not stretch or shrink remembered session widths', () => {
  const sizing = retainSessionWidths(legacy(), ['a', 'b'], 1500);
  const before = sessionStrip(sizing, ['a', 'b'], 1500).widths;
  for (const viewport of [0, 300, 680, 1500, 5000]) {
    approx(sessionStrip(sizing, ['a', 'b'], viewport).widths, before);
    assert.strictEqual(retainSessionWidths(sizing, ['a', 'b'], viewport), sizing);
  }
  assert.equal(sessionStrip(sizing, ['a', 'b'], 300).scrolls, true);
  assert.equal(sessionStrip(sizing, ['a', 'b'], 5000).scrolls, false);
});

test('legacy count-specific ratios and spans migrate once without changing legacy fields', () => {
  const old = { columns: { 2: [2, 1] }, rows: { 2: { 0: 900 } }, spans: { 2: 1300 } };
  const first = sessionStrip(old, ['a', 'b'], 1800);
  approx(first.widths, [1300 * 2 / 3, 1300 / 3]);
  assert.equal(first.usable, 1300);
  const frozen = retainSessionWidths(old, ['a', 'b'], 1800);
  assert.notStrictEqual(frozen, old);
  assert.strictEqual(frozen.columns, old.columns);
  assert.strictEqual(frozen.rows, old.rows);
  assert.strictEqual(frozen.spans, old.spans);
  assert.equal(Object.hasOwn(old, 'paneWidths'), false);
  approx(sessionStrip(frozen, ['a', 'b'], 500).widths, first.widths);
  approx(sessionStrip(frozen, ['a', 'b', 'c'], 5000).widths, [...first.widths, 380]);
});

test('empty initialization makes the first newly added session default to 380px', () => {
  const old = legacy();
  assert.deepEqual(sessionStrip(old, [], 1500), { widths: [], usable: 0, scrolls: false });
  const frozen = retainSessionWidths(old, [], 1500);
  assert.ok(Object.hasOwn(frozen, 'paneWidths'));
  assert.strictEqual(retainSessionWidths(frozen, [], 2000), frozen);
  assert.deepEqual(sessionStrip(frozen, ['first'], 5000), { widths: [380], usable: 380, scrolls: false });
});

test('once initialized, unknown IDs use default pixels despite other legacy count profiles', () => {
  const sizing = { columns: { 3: [1, 8, 1] }, rows: {}, spans: { 3: 3000 }, paneWidths: { a: 420 } };
  const result = sessionStrip(sizing, ['a', 'b', 'c'], 8000);
  assert.deepEqual(result, { widths: [420, 380, 380], usable: 1180, scrolls: false });
  assert.equal(sessionStrip(sizing, ['a', 'b', 'c'], 1180 + 3 * TILE_GAP).scrolls, false);
  assert.equal(sessionStrip(sizing, ['a', 'b', 'c'], 1180 + 3 * TILE_GAP - 1).scrolls, true);
});

test('resize changes only its target ID and retains hidden/removed IDs', () => {
  const sizing = { ...legacy(), paneWidths: { a: 550, b: 700, removed: 610 } };
  const next = resizeSessionWidth(sizing, ['a', 'b', 'new'], 1000, 'b', 125);
  assert.deepEqual({ ...next.paneWidths }, { a: 550, b: 825, removed: 610, new: 380 });
  assert.deepEqual(sizing.paneWidths, { a: 550, b: 700, removed: 610 });
  assert.strictEqual(next.columns, sizing.columns);
  assert.strictEqual(next.spans, sizing.spans);
  approx(sessionStrip(next, ['new', 'a', 'b'], 5000).widths, [380, 550, 825]);
});

test('resize clamps 340…10000 and zero, invalid, missing, or limited motion returns the original object', () => {
  const old = legacy();
  for (const delta of [0, NaN, Infinity, -Infinity, '10']) {
    assert.strictEqual(resizeSessionWidth(old, ['a', 'b'], 1500, 'a', delta), old);
  }
  assert.strictEqual(resizeSessionWidth(old, ['a', 'b'], 1500, 'missing', 50), old);
  const low = { ...legacy(), paneWidths: { a: MIN_TILE_WIDTH } };
  assert.strictEqual(resizeSessionWidth(low, ['a', 'unknown'], 1500, 'a', -1), low);
  const high = { ...legacy(), paneWidths: { a: 10000 } };
  assert.strictEqual(resizeSessionWidth(high, ['a'], 1500, 'a', 1), high);
  const shrunk = resizeSessionWidth(old, ['a', 'b'], 1500, 'a', -1e9);
  assert.equal(shrunk.paneWidths.a, 340);
  assert.equal(resizeSessionWidth(shrunk, ['a', 'b'], 1500, 'a', 1e9).paneWidths.a, 10000);
});

test('parseSizing keeps the exact old shape when the optional map is absent', () => {
  assert.deepEqual(parseSizing(null), { columns: {}, rows: {}, spans: {} });
  assert.deepEqual(parseSizing('{}'), { columns: {}, rows: {}, spans: {} });
  const parsed = parseSizing(JSON.stringify({ columns: { 2: [1, 1] }, rows: { 2: { 0: 1000 } }, spans: { 2: 900 } }));
  assert.deepEqual(parsed, { columns: { 2: [0.5, 0.5] }, rows: {}, spans: { 2: 900 } });
  assert.equal(Object.hasOwn(parsed, 'paneWidths'), false);
});

test('width-map storage clamps own finite numbers, ignores invalid/prototype keys, and stays optional', () => {
  const parsed = parseSizing('{"paneWidths":{"a":20,"b":20000,"c":500.25,"str":"700","nil":null,"obj":{},"__proto__":700,"constructor":800,"prototype":900}}');
  assert.equal(Object.getPrototypeOf(parsed.paneWidths), null);
  assert.deepEqual({ ...parsed.paneWidths }, { a: 340, b: 10000, c: 500.25 });
  for (const invalid of [null, 5, 'bad', []]) {
    const value = parseSizing(JSON.stringify({ paneWidths: invalid }));
    assert.ok(Object.hasOwn(value, 'paneWidths'));
    assert.deepEqual({ ...value.paneWidths }, {});
    assert.deepEqual(sessionStrip(value, ['new'], 3000).widths, [380]);
  }
  assert.equal(Object.hasOwn({}, 'polluted'), false);
});

test('inherited widths and accessors are never used as session pixels or copied into storage', () => {
  const map = Object.create({ inherited: 900, toString: 800 });
  map.a = 440;
  Object.defineProperty(map, 'getter', { enumerable: true, get() { throw new Error('accessor must not execute'); } });
  const sizing = { ...legacy(), paneWidths: map };
  assert.deepEqual(sessionStrip(sizing, ['a', 'inherited', 'toString', 'getter'], 5000).widths, [440, 380, 380, 380]);
  const frozen = retainSessionWidths(sizing, ['a', 'new'], 1500);
  assert.deepEqual({ ...frozen.paneWidths }, { a: 440, new: 380 });
  const inheritedMap = Object.assign(Object.create({ paneWidths: { ghost: 900 } }), legacy());
  const migrated = retainSessionWidths(inheritedMap, ['a'], 1500);
  assert.equal(Object.hasOwn(migrated.paneWidths, 'ghost'), false);
});

test('reserved IDs stay safely unresolved without repeated retain/save churn', () => {
  const ids = ['__proto__', 'constructor', 'prototype'];
  const frozen = retainSessionWidths(legacy(), ids, 1500);
  assert.deepEqual({ ...frozen.paneWidths }, {});
  assert.strictEqual(retainSessionWidths(frozen, ids, 1500), frozen);
  assert.deepEqual(sessionStrip(frozen, ids, 1500).widths, [380, 380, 380]);
  for (const id of ids) assert.strictEqual(resizeSessionWidth(frozen, ids, 1500, id, 100), frozen);
});

test('refresh round-trip preserves widths by ID, including removed sessions', () => {
  let sizing = retainSessionWidths(legacy(), ['a', 'b'], 1500);
  sizing = resizeSessionWidth(sizing, ['a', 'b'], 1500, 'b', 123.5);
  sizing = retainSessionWidths(sizing, ['new', 'a', 'b'], 1500);
  const refreshed = parseSizing(JSON.stringify(sizing));
  approx(sessionStrip(refreshed, ['b', 'new', 'a'], 500).widths, sessionStrip(sizing, ['b', 'new', 'a'], 5000).widths);
  assert.strictEqual(retainSessionWidths(refreshed, ['a'], 900), refreshed);
  assert.ok(Object.hasOwn(refreshed.paneWidths, 'b'));
});

test('sizing store save, reload and storage events retain and sanitize the optional ID map', () => {
  const { storage, events, change } = fixture();
  const store = createSizingStore(() => storage, events);
  const sizing = retainSessionWidths(legacy(), ['a', 'b'], 1500);
  store.save(sizing);
  store.dispose();
  const reloaded = createSizingStore(() => storage, events);
  approx(sessionStrip(reloaded.getSnapshot().sizing, ['a', 'b'], 5000).widths, sessionStrip(sizing, ['a', 'b'], 1500).widths);
  let updates = 0;
  const stop = reloaded.subscribe(() => updates++);
  storage.setItem(LAYOUT_KEY, '{"paneWidths":{"a":500,"b":20,"removed":10000,"__proto__":900}}');
  change('unrelated'); change(LAYOUT_KEY, {});
  assert.equal(updates, 0);
  change(LAYOUT_KEY);
  assert.equal(updates, 1);
  assert.deepEqual({ ...reloaded.getSnapshot().sizing.paneWidths }, { a: 500, b: 340, removed: 10000 });
  storage.setItem(LAYOUT_KEY, '{}'); change(null);
  assert.equal(Object.hasOwn(reloaded.getSnapshot().sizing, 'paneWidths'), false);
  stop(); reloaded.dispose();
});
