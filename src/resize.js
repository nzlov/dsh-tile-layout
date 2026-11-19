const resizeCountSupported = count => Number.isSafeInteger(count) && count >= 1;
const resizeSum = values => values.reduce((total, value) => total + value, 0);
const resizeEqual = (count, total = 1) => Array(count).fill(total / count);

function hasResizeWeights(value, count) {
  if (!Array.isArray(value) || value.length !== count) return false;
  for (let index = 0; index < count; index++) {
    if (!Number.isFinite(value[index]) || value[index] <= 0) return false;
  }
  return true;
}

/** Storage boundary: normalize dense positive finite weights, otherwise use equal shares. */
export function sanitizeColumnRatios(value, count) {
  if (!resizeCountSupported(count)) return [];
  if (count === 1 || !hasResizeWeights(value, count)) return resizeEqual(count);
  if (resizeSum(value) === 1) return [...value];
  // Sum as bounded weights so even large but finite inputs cannot overflow.
  const max = Math.max(...value);
  const scaled = value.map(weight => weight / max);
  const total = resizeSum(scaled);
  const normalized = scaled.map(weight => weight / total);
  // An extreme disparity can underflow to zero and is not a usable ratio.
  return normalized.includes(0) ? resizeEqual(count) : normalized;
}

function projectResizeTracks(ratios, width, minimum) {
  const count = ratios.length;
  const widths = Array(count).fill(minimum);
  const pinned = Array(count).fill(false);
  let fixedCount = 0;
  while (fixedCount < count) {
    const remainingWidth = width - fixedCount * minimum;
    let remainingWeight = 0;
    for (let index = 0; index < count; index++) {
      if (!pinned[index]) remainingWeight += ratios[index];
    }
    const previousFixedCount = fixedCount;
    for (let index = 0; index < count; index++) {
      if (pinned[index]) continue;
      const share = ratios[index] / remainingWeight * remainingWidth;
      if (share < minimum) {
        pinned[index] = true;
        widths[index] = minimum;
        fixedCount++;
      } else {
        widths[index] = share;
      }
    }
    if (fixedCount === previousFixedCount) break;
  }
  return { widths, pinned };
}

/** Calculate pixel tracks without writing the temporary minimum-width projection back to storage. */
export function columnWidths(ratios, usableWidth, minPx) {
  if (!Array.isArray(ratios) || !resizeCountSupported(ratios.length)) return [];
  const count = ratios.length;
  const width = Number.isFinite(usableWidth) && usableWidth > 0 ? usableWidth : 0;
  const minimum = Number.isFinite(minPx) && minPx > 0 ? minPx : 0;
  // The minimum is unattainable in a narrower container; fit without overflow.
  if (count === 1 || width / count <= minimum) return resizeEqual(count, width);
  return projectResizeTracks(sanitizeColumnRatios(ratios, count), width, minimum).widths;
}

/**
 * Move the boundary after `boundaryIndex` by a signed pixel delta. Only the
 * adjacent shares may change. Ratios must already be normalized; the input
 * reference is returned intact when the requested motion cannot be realized.
 */
export function resizeColumnPair(ratios, boundaryIndex, deltaPx, usableWidth, minPx) {
  if (!Array.isArray(ratios) || !resizeCountSupported(ratios.length)
    || !hasResizeWeights(ratios, ratios.length) || Math.abs(resizeSum(ratios) - 1) > 8 * Number.EPSILON
    || !Number.isInteger(boundaryIndex) || boundaryIndex < 0 || boundaryIndex >= ratios.length - 1
    || !Number.isFinite(deltaPx) || deltaPx === 0 || !Number.isFinite(usableWidth) || usableWidth <= 0
    || !Number.isFinite(minPx) || minPx < 0 || usableWidth / ratios.length <= minPx) return ratios;

  const left = boundaryIndex;
  const right = left + 1;
  const { widths, pinned } = projectResizeTracks(ratios, usableWidth, minPx);
  const pairWidth = widths[left] + widths[right];
  if (pairWidth / 2 <= minPx) return ratios;
  const epsilon = usableWidth * (8 * Number.EPSILON);
  const nextWidth = Math.min(pairWidth - minPx, Math.max(minPx, widths[left] + deltaPx));
  if (Math.abs(nextWidth - widths[left]) <= epsilon) return ratios;

  const pairRatio = ratios[left] + ratios[right];
  // Keep positive storage shares even for a caller that requests a 0px minimum.
  const lowerShare = pairRatio * Number.EPSILON;
  const nextLeft = Math.min(pairRatio - lowerShare, Math.max(lowerShare, nextWidth / pairWidth * pairRatio));
  const nextRight = pairRatio - nextLeft;
  if (nextLeft <= 0 || nextRight <= 0 || nextLeft === ratios[left]) return ratios;
  const next = [...ratios];
  next[left] = nextLeft;
  next[right] = nextRight;

  if (pinned[left] || pinned[right]) {
    // When pulling a projected pane out of its minimum, freezing the other
    // stored weights cannot always freeze their rendered widths. Reject the
    // ambiguous gesture rather than move an unrelated divider or jump tracks.
    const projected = projectResizeTracks(next, usableWidth, minPx).widths;
    if (projected.some((width, index) => Math.abs(width - (
      index === left ? nextWidth : index === right ? pairWidth - nextWidth : widths[index]
    )) > epsilon)) return ratios;
  }
  return next;
}
