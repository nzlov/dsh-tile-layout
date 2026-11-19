import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSizingStore, LAYOUT_KEY, MIN_TILE_WIDTH, parseSizing, stripGeometry, stripWidthGesture, tiledTracks } from '../src/layout.js';
import { columnWidths, sanitizeColumnRatios } from '../src/resize.js';


test('tiles keep a horizontal strip at the minimum size with any number of sessions', () => {
  assert.deepEqual(stripGeometry(2, 1150), { usable: 1126, scrolls: false });
  assert.deepEqual(stripGeometry(7, 1150), { usable: 2660, scrolls: true });
  assert.deepEqual(stripGeometry(7, 1150, 2510), { usable: 2510, scrolls: true });
  assert.ok(stripGeometry(7, 10, 20).usable >= 7 * MIN_TILE_WIDTH);
  assert.equal(tiledTracks(['340px', '350px', '360px']), '340px 12px 350px 12px 360px');
});

test('width preferences survive reload while legacy saved heights are discarded', () => {
  const memory = new Map();
  const events = new EventTarget();
  const storage = () => ({ getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) });
  const store = createSizingStore(storage, events);
  const value = { columns: { 6: [1, 1, 1, 1, 1, 1] }, spans: { 6: 2220 }, rows: { 6: { 0: 1280 } } };
  store.save(value);
  store.dispose();
  assert.ok(memory.has(LAYOUT_KEY));
  const restored = createSizingStore(storage, events);
  assert.deepEqual(restored.getSnapshot().sizing, { columns: { 6: Array(6).fill(1 / 6) }, rows: {}, spans: { 6: 2220 } });
  assert.deepEqual(parseSizing('{broken'), { columns: {}, rows: {}, spans: {} });
  restored.dispose();
});

const emptySizing = () => ({ columns: {}, rows: {}, spans: {} });
function renderedWidths(sizing, count, viewport) {
  return columnWidths(sanitizeColumnRatios(sizing.columns[count], count), stripGeometry(count, viewport, sizing.spans[count]).usable, MIN_TILE_WIDTH);
}

test('every pane including the last has a gap budget at the exact minimum-fit boundary', () => {
  for (const count of [1, 2, 5]) {
    const viewport = count * (MIN_TILE_WIDTH + 12);
    assert.deepEqual(stripGeometry(count, viewport), { usable: count * MIN_TILE_WIDTH, scrolls: false });
  }
});

test('the last pane can grow into horizontal overflow without changing other pane widths', () => {
  const sizing = emptySizing();
  const before = renderedWidths(sizing, 3, 1200);
  const gesture = stripWidthGesture(sizing, 3, 1200, 2);
  assert.equal(gesture.independent, true);
  assert.strictEqual(gesture.resize(0), sizing);
  const next = gesture.resize(180);
  const after = renderedWidths(next, 3, 1200);
  assert.ok(after.slice(0, 2).every((width, index) => Math.abs(width - before[index]) < 1e-7));
  assert.ok(Math.abs(after[2] - before[2] - 180) < 0.001);
  assert.equal(stripGeometry(3, 1200, next.spans[3]).scrolls, true);
  const smaller = renderedWidths(gesture.resize(10), 3, 1200);
  assert.ok(Math.abs(smaller[2] - before[2] - 10) < 0.001);
});

test('the last pane and a single pane can shrink without snapping back to viewport width', () => {
  for (const count of [1, 3]) {
    const sizing = emptySizing();
    const result = stripWidthGesture(sizing, count, 1600, count - 1).resize(-10000);
    const widths = renderedWidths(result, count, 1600);
    assert.ok(Math.abs(widths[count - 1] - MIN_TILE_WIDTH) < 0.001);
    assert.ok(result.spans[count] < stripGeometry(count, 1600).usable);
  }
});

test('two minimum-width panes can still expand through their divider', () => {
  const sizing = emptySizing();
  const gesture = stripWidthGesture(sizing, 2, 704, 0);
  assert.equal(gesture.independent, true);
  assert.deepEqual(renderedWidths(gesture.resize(40), 2, 704), [380, 340]);
});

test('every divider changes only the pane to its left, including after save and reload', () => {
  for (const count of [1, 2, 3, 7]) {
    for (let boundary = 0; boundary < count; boundary++) {
      for (const delta of [-200, 20, 200]) {
        const sizing = emptySizing();
        const before = renderedWidths(sizing, count, 1200);
        const gesture = stripWidthGesture(sizing, count, 1200, boundary);
        assert.equal(gesture.independent, true);
        assert.strictEqual(gesture.resize(0), sizing);
        const next = gesture.resize(delta);
        const after = renderedWidths(next, count, 1200);
        const restored = renderedWidths(parseSizing(JSON.stringify(next)), count, 1200);
        for (let index = 0; index < count; index++) {
          const expected = index === boundary ? Math.max(MIN_TILE_WIDTH, before[index] + delta) : before[index];
          assert.ok(Math.abs(after[index] - expected) < 1e-7, `pane ${index} at boundary ${boundary}, delta ${delta}`);
          assert.ok(Math.abs(restored[index] - expected) < 1e-7);
        }
      }
    }
  }
});
