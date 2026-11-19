import assert from 'node:assert/strict';
import test from 'node:test';
import { isolateTileNavigation, isNativeFrameMessage, nativeFrameTarget, nativeFrameToken, nativeFrameUrl, nativeFrameLaunch, nativeSessionRoot, nativeReadyNeedsRetry, nativeTileColumns, queueNativeOpen, TILE_FRAME_CHANNEL, NATIVE_TILE_CHROME_CSS } from '../src/native-frame.js';

function makeStorage() {
  class Storage {
    values = new Map();
    getItem(key) { return this.values.get(key) ?? null; }
    setItem(key, value) { this.values.set(key, String(value)); }
    removeItem(key) { this.values.delete(key); }
  }
  return { Storage, storage: new Storage(), other: new Storage() };
}

test('native frames reuse the current server and path, without forwarding query parameters', () => {
  const address = new URL(nativeFrameUrl('https://gui.example.test/dsh/?other=discard#pane', 's 中文/#', 'token'));
  assert.equal(address.origin, 'https://gui.example.test');
  assert.equal(address.pathname, '/dsh/');
  assert.equal(address.hash, '');
  assert.equal(address.searchParams.get('other'), null);
  assert.equal(address.searchParams.get('dshTileSession'), 's 中文/#');
  assert.equal(address.searchParams.get('dshTileToken'), 'token');
});

test('embedded mode requires an actual parent iframe and matching data markers', () => {
  const win = {
    location: { href: nativeFrameUrl('http://localhost:3001/', 's', 'token') },
    parent: {}, frameElement: { dataset: { dshSessionTile: 's', dshTileToken: 'token' } },
  };
  assert.deepEqual(nativeFrameTarget(win), { sessionId: 's', token: 'token' });
  win.frameElement.dataset.dshTileToken = 'wrong';
  assert.equal(nativeFrameTarget(win), undefined);
  win.frameElement.dataset.dshTileToken = 'token';
  win.parent = win;
  assert.equal(nativeFrameTarget(win), undefined);
});

test('only navigation persistence is isolated; native drafts and theme storage are untouched', () => {
  const { Storage, storage, other } = makeStorage();
  const key = 'dsh.sessions.current';
  storage.setItem(key, 'parent-selection');
  other.setItem(key, 'other-storage');
  const original = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem');
  const restore = isolateTileNavigation(Storage.prototype, storage, 'tile-session');
  assert.equal(storage.getItem(key), JSON.stringify({ sessionId: 'tile-session' }));
  storage.setItem(key, 'tile-selection');
  assert.equal(storage.getItem(key), 'tile-selection');
  assert.equal(storage.values.get(key), 'parent-selection');
  storage.setItem('draft', 'native draft');
  storage.setItem('theme', 'dark');
  assert.equal(storage.values.get('draft'), 'native draft');
  assert.equal(storage.values.get('theme'), 'dark');
  other.setItem(key, 'still-native');
  assert.equal(other.values.get(key), 'still-native');
  storage.removeItem(key);
  assert.equal(storage.getItem(key), null);
  assert.equal(storage.values.get(key), 'parent-selection');
  restore();
  assert.deepEqual(Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem'), original);
  assert.equal(storage.getItem(key), 'parent-selection');
  storage.setItem(key, 'normal');
  assert.equal(storage.values.get(key), 'normal');
});

test('partial storage isolation failures restore any installed wrappers', () => {
  const { Storage, storage } = makeStorage();
  const original = Storage.prototype.getItem;
  Object.defineProperty(Storage.prototype, 'setItem', { value: Storage.prototype.setItem, configurable: false, writable: false });
  assert.throws(() => isolateTileNavigation(Storage.prototype, storage, 's'));
  assert.strictEqual(Storage.prototype.getItem, original);
});

test('messages need the exact iframe window, origin, channel and per-frame token', () => {
  const frame = {};
  const data = { channel: TILE_FRAME_CHANNEL, token: 'one', type: 'ready' };
  const event = { source: frame, origin: 'http://localhost:3001', data };
  assert.equal(isNativeFrameMessage(event, frame, event.origin, 'one'), true);
  assert.equal(isNativeFrameMessage(event, {}, event.origin, 'one'), false);
  assert.equal(isNativeFrameMessage(event, frame, 'https://other.test', 'one'), false);
  assert.equal(isNativeFrameMessage(event, frame, event.origin, 'two'), false);
  assert.equal(isNativeFrameMessage({ ...event, data: { ...data, channel: 'other' } }, frame, event.origin, 'one'), false);
});


test('removing the left rail preserves the native center and right sidebar tracks', () => {
  for (const width of [0, 56, 280]) {
    const rest = 'minmax(400px, 1fr) minmax(0px, 530px)';
    assert.equal(nativeTileColumns(`${width}px ${rest}`), `0px ${rest}`);
  }
  assert.equal(nativeTileColumns('56.5px minmax(0px, 1fr) minmax(0px, 0px)'), '0px minmax(0px, 1fr) minmax(0px, 0px)');
  assert.equal(nativeTileColumns('none'), undefined);
  assert.equal(nativeTileColumns(undefined), undefined);
});

test('tile startup waits until native restoration has assigned its main reference', () => {
  const tasks = [];
  let main, opened = 0;
  const boot = queueNativeOpen(() => ({ phase: 'ready' }), () => { main = 'target'; opened++; }, task => tasks.push(task));
  // Native retain publishes synchronously before its mainReference assignment.
  boot.check();
  boot.check();
  assert.equal(tasks.length, 1);
  assert.equal(opened, 0);
  main = 'restored';
  tasks.shift()();
  assert.equal(main, 'target');
  assert.equal(opened, 1);
  boot.check();
  assert.equal(tasks.length, 0);
  boot.dispose();
});

test('two queued tile startups remain independent and disposal cancels unopened work', () => {
  const tasks = [], opened = [];
  const phase = { phase: 'ready' };
  const first = queueNativeOpen(() => phase, () => opened.push('first'), task => tasks.push(task));
  const second = queueNativeOpen(() => phase, () => opened.push('second'), task => tasks.push(task));
  first.check(); second.check();
  while (tasks.length) tasks.shift()();
  assert.deepEqual(opened, ['first', 'second']);
  const cancelled = queueNativeOpen(() => phase, () => opened.push('cancelled'), task => tasks.push(task));
  cancelled.check(); cancelled.dispose(); tasks.shift()();
  assert.deepEqual(opened, ['first', 'second']);
  first.dispose(); second.dispose();
});

test('a temporarily unavailable session list can be retried without consuming startup', () => {
  const tasks = [];
  let phase = 'ready', count = 0;
  const boot = queueNativeOpen(() => ({ phase }), () => count++, task => tasks.push(task));
  boot.check(); phase = 'pending'; tasks.shift()();
  assert.equal(count, 0);
  phase = 'ready'; boot.check(); tasks.shift()();
  assert.equal(count, 1);
  boot.dispose();
});

test('frame correlation tokens also work without secure-context randomUUID', () => {
  assert.equal(nativeFrameToken({ randomUUID: () => 'uuid' }), 'uuid');
  assert.equal(nativeFrameToken({ getRandomValues: bytes => bytes.fill(0x12) }), '12'.repeat(16));
  assert.ok(nativeFrameToken({}).length > 10);
});


test('shared wallpaper transparency is limited to embedded structural layers, not controls or theme tokens', () => {
  const css = NATIVE_TILE_CHROME_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = css.split('}').filter(rule => rule.trim()).flatMap(rule => rule.split('{')[0].split(','));
  for (const selector of selectors) {
    assert.match(selector.trim(), /^html(?::root)?\[data-dsh-native-tile\]/);
    assert.doesNotMatch(selector, /\b(?:input|textarea|button|menu)\b/);
    assert.ok(!selector.includes('*'));
  }
  assert.match(css, /html:root\[data-dsh-native-tile\]::before/);
  assert.match(css, /\[data-dsh-boot\]::after/);
  assert.match(css, /background: transparent !important/);
  assert.doesNotMatch(css, /--dsw-[a-z0-9-]+\s*:/);
});


test('a load attempt freezes target and token when its durable session prop changes', () => {
  let tokens = 0;
  const issue = () => `token-${++tokens}`;
  const first = nativeFrameLaunch(null, 0, 'blank-a', issue);
  const same = nativeFrameLaunch(first, 0, 'working-b', issue);
  assert.strictEqual(same, first);
  assert.deepEqual(same, { attempt: 0, sessionId: 'blank-a', token: 'token-1' });
  assert.equal(tokens, 1);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(nativeFrameUrl('https://gui.test/', same.sessionId, same.token), nativeFrameUrl('https://gui.test/', first.sessionId, first.token));
});

test('activation uses the latest target and retry or remount creates a fresh launch token', () => {
  let tokens = 0;
  const issue = () => `token-${++tokens}`;
  let latest = 'blank-a';
  latest = 'working-b'; // No launch exists until the offscreen card activates.
  const first = nativeFrameLaunch(null, 0, latest, issue);
  assert.equal(first.sessionId, 'working-b');
  const retry = nativeFrameLaunch(first, 1, 'working-c', issue);
  assert.deepEqual(retry, { attempt: 1, sessionId: 'working-c', token: 'token-2' });
  assert.notStrictEqual(retry, first);
  assert.strictEqual(nativeFrameLaunch(retry, 1, 'later-d', issue), retry);
  const afterRefresh = nativeFrameLaunch(null, 0, 'working-c', issue);
  assert.deepEqual(afterRefresh, { attempt: 0, sessionId: 'working-c', token: 'token-3' });
});

test('messages must match the captured launch session as well as source origin and token', () => {
  const frame = {}, origin = 'https://gui.test';
  const previous = nativeFrameLaunch(null, 0, 'blank-a', () => 'old');
  const current = nativeFrameLaunch(previous, 1, 'working-b', () => 'new');
  const event = { source: frame, origin, data: { channel: TILE_FRAME_CHANNEL, token: current.token, sessionId: current.sessionId, currentSessionId: 'working-c', type: 'ready' } };
  assert.equal(isNativeFrameMessage(event, frame, origin, current.token, current.sessionId), true);
  assert.equal(isNativeFrameMessage({ ...event, data: { ...event.data, token: previous.token, sessionId: previous.sessionId } }, frame, origin, current.token, current.sessionId), false);
  assert.equal(isNativeFrameMessage({ ...event, data: { ...event.data, sessionId: previous.sessionId } }, frame, origin, current.token, current.sessionId), false);
  const missing = { ...event.data }; delete missing.sessionId;
  assert.equal(isNativeFrameMessage({ ...event, data: missing }, frame, origin, current.token, current.sessionId), false);
  assert.equal(isNativeFrameMessage(event, {}, origin, current.token, current.sessionId), false);
  assert.equal(isNativeFrameMessage(event, frame, 'https://other.test', current.token, current.sessionId), false);
});

test('root metadata is explicit only for known own rows and distinguishes subagent drilldowns', () => {
  const byId = Object.assign(Object.create({ inherited: {} }), {
    root: {}, working: { origin: undefined }, subagent: { origin: 'subagent' }, nullRow: null,
  });
  const snapshot = { byId };
  assert.equal(nativeSessionRoot(snapshot, 'root'), true);
  assert.equal(nativeSessionRoot(snapshot, 'working'), true);
  assert.equal(nativeSessionRoot(snapshot, 'subagent'), false);
  assert.equal(nativeSessionRoot(snapshot, 'unknown'), undefined);
  assert.equal(nativeSessionRoot(snapshot, 'inherited'), undefined);
  assert.equal(nativeSessionRoot(snapshot, 'nullRow'), undefined);
  assert.equal(nativeSessionRoot(undefined, 'root'), undefined);
});


test('ready from a document-only refresh cannot overwrite a newer saved root with its stale URL target', () => {
  assert.equal(nativeReadyNeedsRetry('blank-a', 'working-b', 'blank-a'), true);
  assert.equal(nativeReadyNeedsRetry('blank-a', 'working-b', 'working-b'), false);
  assert.equal(nativeReadyNeedsRetry('blank-a', 'blank-a', 'blank-a'), false);
  assert.equal(nativeReadyNeedsRetry('blank-a', undefined, 'blank-a'), false);
});
