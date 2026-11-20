import { columnWidths, sanitizeColumnRatios } from './resize.js';

export const LAYOUT_KEY = 'dsh-tile-layout:sizing:v1';
export const TILE_GAP = 12;
export const MIN_TILE_WIDTH = 340;
export const DEFAULT_OVERFLOW_WIDTH = 380;
export const MAX_OVERFLOW_WIDTH = 1440;

export function stripGeometry(count, viewportWidth, span) {
  // Every pane owns a trailing hit area, including the rightmost pane.
  const available = Math.max(0, viewportWidth - count * TILE_GAP);
  const usable = Number.isFinite(span) ? Math.max(count * MIN_TILE_WIDTH, span)
    : available >= count * MIN_TILE_WIDTH ? available : count * DEFAULT_OVERFLOW_WIDTH;
  return { usable, scrolls: usable > available };
}

export function stripWidthGesture(sizing, count, viewportWidth, boundary) {
  if (!Number.isInteger(boundary) || boundary < 0 || boundary >= count) return undefined;
  const geometry = stripGeometry(count, viewportWidth, sizing.spans[count]);
  const initial = columnWidths(sanitizeColumnRatios(sizing.columns[count], count), geometry.usable, MIN_TILE_WIDTH);
  const max = Math.max(initial[boundary], 10000);
  return {
    initial, max, independent: true,
    resize(delta) {
      if (!Number.isFinite(delta) || delta === 0) return sizing;
      // A separator belongs only to the pane on its left. Changing the strip's
      // total width preserves every other pane's pixel width in either direction.
      const nextWidth = Math.max(MIN_TILE_WIDTH, Math.min(max, initial[boundary] + delta));
      if (nextWidth === initial[boundary]) return sizing;
      const span = geometry.usable - initial[boundary] + nextWidth;
      const ratios = initial.map((width, index) => (index === boundary ? nextWidth : width) / span);
      return { ...sizing, columns: { ...sizing.columns, [count]: ratios }, spans: { ...sizing.spans, [count]: span } };
    },
  };
}

const MAX_SESSION_WIDTH = 10000;
const paneIdAllowed = id => typeof id === 'string' && id.length > 0
  && id !== '__proto__' && id !== 'constructor' && id !== 'prototype';
const hasPaneWidths = sizing => sizing !== null && typeof sizing === 'object' && Object.hasOwn(sizing, 'paneWidths');

function ownPaneWidth(map, id) {
  if (!paneIdAllowed(id) || map === null || typeof map !== 'object' || Array.isArray(map) || !Object.hasOwn(map, id)) return undefined;
  // Data properties only: inherited values and accessors never become widths.
  const value = Object.getOwnPropertyDescriptor(map, id)?.value;
  return Number.isFinite(value) ? Math.max(MIN_TILE_WIDTH, Math.min(MAX_SESSION_WIDTH, value)) : undefined;
}

function sanitizePaneWidths(value) {
  const map = Object.create(null);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return map;
  for (const id of Object.keys(value)) {
    const width = ownPaneWidth(value, id);
    if (width !== undefined) map[id] = width;
  }
  return map;
}

/** Resolve fixed pixels by Session identity; legacy ratios are read only for migration. */
export function sessionStrip(sizing, ids, viewportWidth) {
  if (ids.length === 0) return { widths: [], usable: 0, scrolls: false };
  const viewport = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  if (!hasPaneWidths(sizing)) {
    const geometry = stripGeometry(ids.length, viewport, sizing.spans?.[ids.length]);
    return {
      widths: columnWidths(sanitizeColumnRatios(sizing.columns?.[ids.length], ids.length), geometry.usable, MIN_TILE_WIDTH),
      usable: geometry.usable,
      scrolls: geometry.scrolls,
    };
  }
  const widths = ids.map(id => ownPaneWidth(sizing.paneWidths, id) ?? DEFAULT_OVERFLOW_WIDTH);
  const usable = widths.reduce((sum, width) => sum + width, 0);
  return { widths, usable, scrolls: usable + ids.length * TILE_GAP > viewport };
}

/** Freeze the current projection once, keeping remembered widths of removed Sessions. */
export function retainSessionWidths(sizing, ids, viewportWidth) {
  if (hasPaneWidths(sizing) && ids.every(id => !paneIdAllowed(id) || (
    ownPaneWidth(sizing.paneWidths, id) !== undefined
      && Object.getOwnPropertyDescriptor(sizing.paneWidths, id)?.value === ownPaneWidth(sizing.paneWidths, id)
  ))) return sizing;
  const { widths } = sessionStrip(sizing, ids, viewportWidth);
  const paneWidths = sanitizePaneWidths(hasPaneWidths(sizing) ? sizing.paneWidths : undefined);
  ids.forEach((id, index) => { if (paneIdAllowed(id)) paneWidths[id] = widths[index]; });
  return { ...sizing, paneWidths };
}

/** A drag changes only its named Session; zero or clamped motion never writes migration state. */
export function resizeSessionWidth(sizing, ids, viewportWidth, id, delta) {
  if (!paneIdAllowed(id) || !ids.includes(id) || !Number.isFinite(delta) || delta === 0) return sizing;
  const baseline = retainSessionWidths(sizing, ids, viewportWidth);
  const width = ownPaneWidth(baseline.paneWidths, id);
  const nextWidth = Math.max(MIN_TILE_WIDTH, Math.min(MAX_SESSION_WIDTH, width + delta));
  if (nextWidth === width) return sizing;
  const paneWidths = sanitizePaneWidths(baseline.paneWidths);
  paneWidths[id] = nextWidth;
  return { ...baseline, paneWidths };
}

export function parseSizing(raw) {
  const sizing = { columns: {}, rows: {}, spans: {} };
  try {
    const value = JSON.parse(raw);
    const counts = new Set([...Object.keys(value?.columns ?? {}), ...Object.keys(value?.spans ?? {})]);
    for (const key of counts) {
      if (!/^[1-9][0-9]{0,3}$/.test(key)) continue;
      const count = Number(key);
      const ratios = value?.columns?.[count];
      if (count > 1 && Array.isArray(ratios) && ratios.length === count) sizing.columns[count] = sanitizeColumnRatios(ratios, count);
      const span = value?.spans?.[count];
      if (Number.isFinite(span)) sizing.spans[count] = Math.max(count * MIN_TILE_WIDTH, Math.min(count * 10000, span));
      // Legacy pixel heights are intentionally discarded. Panes always fill
      // the current scrollport height; saved widths remain compatible.
    }
    if (value !== null && typeof value === 'object' && Object.hasOwn(value, 'paneWidths')) {
      sizing.paneWidths = sanitizePaneWidths(value.paneWidths);
    }
  } catch { /* Unavailable or damaged storage starts with equal sizes. */ }
  return sizing;
}

export function tiledTracks(sizes) {
  return sizes.map((size, index) => `${index ? `${TILE_GAP}px ` : ''}${size}`).join(' ');
}

export function createSizingStore(getStorage, events) {
  const listeners = new Set();
  let snapshot = { sizing: parseSizing(null), saveFailed: false };
  try { snapshot.sizing = parseSizing(getStorage().getItem(LAYOUT_KEY)); }
  catch { snapshot.saveFailed = true; }
  function publish(sizing, saveFailed) {
    snapshot = { sizing, saveFailed };
    for (const listener of listeners) listener();
  }
  function change(event) {
    if (event.key !== LAYOUT_KEY && event.key !== null) return;
    try {
      const storage = getStorage();
      if (storage === event.storageArea) publish(parseSizing(storage.getItem(LAYOUT_KEY)), false);
    } catch { publish(snapshot.sizing, true); }
  }
  events.addEventListener('storage', change);
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    sync() {
      if (snapshot.saveFailed) return;
      try {
        const sizing = parseSizing(getStorage().getItem(LAYOUT_KEY));
        if (JSON.stringify(sizing) !== JSON.stringify(snapshot.sizing)) publish(sizing, false);
      } catch { publish(snapshot.sizing, true); }
    },
    save(sizing) {
      let saveFailed = false;
      try { getStorage().setItem(LAYOUT_KEY, JSON.stringify(sizing)); }
      catch { saveFailed = true; }
      publish(sizing, saveFailed);
    },
    dispose() { events.removeEventListener('storage', change); listeners.clear(); },
  };
}

export function createSplitter(React) {
  const { createElement: h, useEffect, useRef } = React;
  return function Splitter({ axis, label, value, min, max, style, begin, nudge, reset }) {
    const active = useRef(null);
    const frame = useRef(null);
    const coordinate = event => axis === 'x' ? event.clientX : event.clientY;
    function cancelFrame() {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    useEffect(() => () => {
      cancelFrame();
      active.current?.cancel();
      active.current = null;
    }, []);
    function finish(event, commit) {
      const gesture = active.current;
      if (!gesture || gesture.id !== event.pointerId) return;
      active.current = null;
      event.currentTarget.removeAttribute('data-resizing');
      cancelFrame();
      if (commit) gesture.update(coordinate(event) - gesture.start, true);
      else gesture.cancel();
    }
    return h('div', {
      className: 'dsh-st-splitter', 'data-axis': axis, style, role: 'separator', tabIndex: 0,
      title: label, 'aria-label': label, 'aria-orientation': axis === 'x' ? 'vertical' : 'horizontal',
      'aria-valuenow': Math.round(value), 'aria-valuemin': Math.round(min), 'aria-valuemax': Math.round(max),
      onPointerDown: event => {
        if (event.button !== 0 || active.current || min >= max) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.setAttribute('data-resizing', 'true');
        active.current = { id: event.pointerId, start: coordinate(event), ...begin() };
      },
      onPointerMove: event => {
        const gesture = active.current;
        if (!gesture || gesture.id !== event.pointerId) return;
        gesture.delta = coordinate(event) - gesture.start;
        if (frame.current !== null) return;
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          if (active.current === gesture) gesture.update(gesture.delta, false);
        });
      },
      onPointerUp: event => finish(event, true),
      onPointerCancel: event => finish(event, false),
      onLostPointerCapture: event => finish(event, false),
      onDoubleClick: reset,
      onKeyDown: event => {
        const keys = axis === 'x' ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 };
        const direction = keys[event.key];
        if (!direction && !['Home', 'End', 'Delete'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Delete') reset();
        else if (event.key === 'Home') nudge(min - value);
        else if (event.key === 'End') nudge(max - value);
        else nudge(direction * (event.shiftKey ? 48 : 16));
      },
    }, h('span', { 'aria-hidden': true }));
  };
}
