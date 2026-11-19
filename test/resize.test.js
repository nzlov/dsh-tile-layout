import assert from 'node:assert/strict';
import { test } from 'node:test';
import { columnWidths, resizeColumnPair, sanitizeColumnRatios } from '../src/resize.js';

function approximately(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (const [index, value] of actual.entries()) {
    assert.ok(Math.abs(value - expected[index]) < 1e-10, `column ${index}: ${value} ≠ ${expected[index]}`);
  }
}

const total = values => values.reduce((sum, value) => sum + value, 0);

test('seeds an equal layout and accepts proportionate positive weights', () => {
  assert.deepEqual(sanitizeColumnRatios(undefined, 1), [1]);
  assert.deepEqual(sanitizeColumnRatios(undefined, 2), [0.5, 0.5]);
  assert.deepEqual(sanitizeColumnRatios(null, 3), [1 / 3, 1 / 3, 1 / 3]);
  assert.deepEqual(sanitizeColumnRatios([], 4), [0.25, 0.25, 0.25, 0.25]);
  approximately(sanitizeColumnRatios([3, 2, 1], 3), [1 / 2, 1 / 3, 1 / 6]);
  assert.deepEqual(sanitizeColumnRatios([Number.MAX_VALUE, Number.MAX_VALUE], 2), [0.5, 0.5]);
  assert.deepEqual(columnWidths([0.25, 0.25, 0.25, 0.25], 1000, 180), [250, 250, 250, 250]);
});

test('moves only the adjacent pair in either direction and keeps total width', () => {
  const ratios = Object.freeze([0.2, 0.25, 0.25, 0.3]);
  const rightward = resizeColumnPair(ratios, 1, 75, 1000, 100);
  const leftward = resizeColumnPair(ratios, 1, -40, 1000, 100);
  approximately(rightward, [0.2, 0.325, 0.175, 0.3]);
  approximately(leftward, [0.2, 0.21, 0.29, 0.3]);
  assert.equal(rightward[0], ratios[0]);
  assert.equal(rightward[3], ratios[3]);
  assert.equal(leftward[0], ratios[0]);
  assert.equal(leftward[3], ratios[3]);
  approximately([total(rightward), total(leftward)], [1, 1]);
  assert.deepEqual(ratios, [0.2, 0.25, 0.25, 0.3]);
});

test('clamps either minimum and preserves the input identity for repeated or zero motion', () => {
  const ratios = [0.35, 0.35, 0.3];
  const positive = resizeColumnPair(ratios, 0, 500, 1000, 240);
  const negative = resizeColumnPair(ratios, 0, -500, 1000, 240);
  approximately(columnWidths(positive, 1000, 240), [460, 240, 300]);
  approximately(columnWidths(negative, 1000, 240), [240, 460, 300]);
  assert.strictEqual(resizeColumnPair(positive, 0, 100, 1000, 240), positive);
  assert.strictEqual(resizeColumnPair(negative, 0, -100, 1000, 240), negative);
  assert.strictEqual(resizeColumnPair(ratios, 0, 0, 1000, 240), ratios);
});

test('a narrow window cannot overwrite saved skew or produce a drag jump', () => {
  const ratios = Object.freeze([0.7, 0.2, 0.1]);
  approximately(columnWidths(ratios, 550, 180), [190, 180, 180]);
  approximately(columnWidths(ratios, 480, 180), [160, 160, 160]);
  assert.strictEqual(resizeColumnPair(ratios, 0, -60, 480, 180), ratios);
  assert.strictEqual(resizeColumnPair(ratios, 0, -60, 540, 180), ratios);
  approximately(columnWidths(ratios, 2000, 180), [1400, 400, 200]);
  assert.deepEqual(ratios, [0.7, 0.2, 0.1]);
});

test('the minimum projection leaves unrelated rendered widths in place during a drag', () => {
  const ratios = [0.1, 0.3, 0.3, 0.3];
  const widths = columnWidths(ratios, 1000, 180);
  approximately(widths, [180, 820 / 3, 820 / 3, 820 / 3]);
  const moved = resizeColumnPair(ratios, 1, 75, 1000, 180);
  assert.equal(moved[0], ratios[0]);
  assert.equal(moved[3], ratios[3]);
  approximately(columnWidths(moved, 1000, 180), [widths[0], widths[1] + 75, widths[2] - 75, widths[3]]);
  // Pulling the first pane off its minimum here would also move the fourth one.
  assert.strictEqual(resizeColumnPair(ratios, 0, 20, 1000, 180), ratios);
});

test('two columns can pull out of a projected minimum without jumping', () => {
  const skew = [0.92, 0.08];
  assert.deepEqual(columnWidths(skew, 700, 200), [500, 200]);
  assert.strictEqual(resizeColumnPair(skew, 0, 10, 700, 200), skew);
  const moved = resizeColumnPair(skew, 0, -25, 700, 200);
  approximately(columnWidths(moved, 700, 200), [475, 225]);
});

test('damaged counts, ratios, and gesture input are safe', () => {
  for (const invalid of [[0, 1], [1, '2'], [Infinity, 1], [Number.MAX_VALUE, Number.MIN_VALUE], [-1, 3], [1, ,], [1, 2, 3]]) {
    assert.deepEqual(sanitizeColumnRatios(invalid, 2), [0.5, 0.5]);
  }
  for (const count of [0, -5, 2.5, '2', NaN, undefined]) assert.deepEqual(sanitizeColumnRatios(null, count), []);
  assert.deepEqual(columnWidths([1], 120, 200), [120]);
  assert.deepEqual(columnWidths([NaN, 0.5], 800, 100), [400, 400]);
  assert.deepEqual(columnWidths([0.5, 0.5], Infinity, 100), [0, 0]);
  assert.deepEqual(columnWidths(null, 800, 100), []);
  const invalidRatios = [2, 1];
  const valid = [0.5, 0.5];
  assert.strictEqual(resizeColumnPair(invalidRatios, 0, 20, 800, 100), invalidRatios);
  for (const boundary of [-1, 1, 0.5, '0']) assert.strictEqual(resizeColumnPair(valid, boundary, 20, 800, 100), valid);
  for (const delta of [NaN, Infinity, '10']) assert.strictEqual(resizeColumnPair(valid, 0, delta, 800, 100), valid);
  assert.strictEqual(resizeColumnPair(valid, 0, 20, 800, -1), valid);
  assert.strictEqual(resizeColumnPair(valid, 0, 20, 0, 100), valid);
});
