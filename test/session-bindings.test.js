import assert from 'node:assert/strict';
import test from 'node:test';
import { canRememberRootSession, chooseSessionTile, createOrderStore, createSessionBindingStore, findSessionTile, parseSessionBindings, SESSION_BINDINGS_KEY, tileSessionId } from '../src/state.js';
import { createSizingStore, retainSessionWidths, resizeSessionWidth, sessionStrip } from '../src/layout.js';

function fixture() {
  const data = new Map(), events = new EventTarget();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const change = (key, storageArea = storage) => events.dispatchEvent(Object.assign(new Event('storage'), { key, storageArea }));
  return { data, events, storage, change };
}

test('blank A becoming working B restores B after F5 without changing card order or width', () => {
  const { events, storage } = fixture();
  const order = createOrderStore(() => storage, events);
  const bindings = createSessionBindingStore(() => storage, events);
  order.prepend('blank-A');
  bindings.bind('blank-A', 'blank-A');
  let sizing = retainSessionWidths({ columns: {}, rows: {}, spans: {} }, ['blank-A'], 1200);
  sizing = resizeSessionWidth(sizing, ['blank-A'], 1200, 'blank-A', -200);
  const width = sessionStrip(sizing, ['blank-A'], 1200).widths[0];
  bindings.bind('blank-A', 'working-B');
  assert.deepEqual(order.getSnapshot().order, ['blank-A']);
  assert.equal(tileSessionId(bindings.getSnapshot().targets, 'blank-A'), 'working-B');
  bindings.dispose(); order.dispose();
  const restored = createSessionBindingStore(() => storage, events);
  const restoredOrder = createOrderStore(() => storage, events);
  assert.deepEqual(restoredOrder.getSnapshot().order, ['blank-A']);
  assert.equal(tileSessionId(restored.getSnapshot().targets, 'blank-A'), 'working-B');
  assert.equal(sessionStrip(sizing, ['blank-A'], 5000).widths[0], width);
  restored.dispose(); restoredOrder.dispose();
});

test('only committed root identities are remembered; subagent previews remain temporary', () => {
  assert.equal(canRememberRootSession('working', true, {}), true);
  assert.equal(canRememberRootSession('working', undefined, {}), false);
  assert.equal(canRememberRootSession('working', undefined, { working: { blank: false } }), true);
  assert.equal(canRememberRootSession('child', false, {}), false);
  assert.equal(canRememberRootSession('child', undefined, { child: { origin: 'subagent' } }), false);
  assert.equal(canRememberRootSession('child', true, { child: { origin: 'subagent' } }), false);
  assert.equal(canRememberRootSession('', true, {}), false);
});

test('preset and workspace transitions remember the latest root independently for each card', () => {
  const { events, storage } = fixture();
  const store = createSessionBindingStore(() => storage, events);
  store.bind('card-a', 'blank'); store.bind('card-b', 'other');
  store.bind('card-a', 'preset-blank'); store.bind('card-a', 'working');
  const parsed = parseSessionBindings(storage.getItem(SESSION_BINDINGS_KEY));
  assert.equal(tileSessionId(parsed, 'card-a'), 'working');
  assert.equal(tileSessionId(parsed, 'card-b'), 'other');
  store.dispose();
});

test('membership follows the bound session, not a reused blank anchor', () => {
  const targets = { 'blank-A': 'working-B' }, order = ['blank-A'];
  assert.equal(findSessionTile(order, targets, 'working-B'), 'blank-A');
  assert.equal(findSessionTile(order, targets, 'blank-A'), undefined);
  assert.equal(chooseSessionTile(order, targets, 'working-B', () => 'unused'), 'blank-A');
  assert.equal(chooseSessionTile(order, targets, 'blank-A', () => 'tile:new'), 'tile:new');
  assert.equal(tileSessionId(targets, 'blank-A'), 'working-B');
});

test('rejoining a closed working session reuses its stable card and width identity', () => {
  const targets = { 'blank-A': 'working-B', other: 'other' };
  assert.equal(chooseSessionTile(['other'], targets, 'working-B', () => 'unused'), 'blank-A');
  assert.equal(chooseSessionTile(['other'], targets, 'brand-new', () => 'unused'), 'brand-new');
});

test('choosing an old blank does not overwrite a closed working-card redirect', () => {
  const targets = { 'blank-A': 'working-B' };
  const next = chooseSessionTile(['other'], targets, 'blank-A', () => 'tile:blank-copy');
  assert.equal(next, 'tile:blank-copy');
  targets[next] = 'blank-A';
  assert.equal(tileSessionId(targets, 'blank-A'), 'working-B');
  assert.equal(chooseSessionTile(['other', next], targets, 'working-B', () => 'unused'), 'blank-A');
});

test('targets are direct card bindings rather than recursive session redirects', () => {
  const targets = { a: 'b', b: 'c' };
  assert.equal(tileSessionId(targets, 'a'), 'b');
  assert.equal(tileSessionId(targets, 'b'), 'c');
  assert.equal(tileSessionId(targets, 'missing'), 'missing');
});

test('binding persistence observes only its own storage area and disposes cleanly', () => {
  const { events, storage, change } = fixture();
  const store = createSessionBindingStore(() => storage, events);
  const initial = store.getSnapshot();
  storage.setItem(SESSION_BINDINGS_KEY, '{"a":"work"}');
  change('unrelated'); change(SESSION_BINDINGS_KEY, {});
  assert.strictEqual(store.getSnapshot(), initial);
  change(SESSION_BINDINGS_KEY);
  assert.equal(tileSessionId(store.getSnapshot().targets, 'a'), 'work');
  store.dispose();
  storage.setItem(SESSION_BINDINGS_KEY, '{"a":"other"}'); change(SESSION_BINDINGS_KEY);
  assert.equal(tileSessionId(store.getSnapshot().targets, 'a'), 'work');
});

test('storage denial retains the working identity in memory and allows retry of the same binding', () => {
  const { events, storage } = fixture();
  let denied = true;
  const store = createSessionBindingStore(() => { if (denied) throw new Error('blocked'); return storage; }, events);
  store.bind('a', 'work');
  assert.equal(store.getSnapshot().targets.a, 'work');
  assert.equal(store.getSnapshot().saveFailed, true);
  denied = false; store.bind('a', 'work');
  assert.equal(store.getSnapshot().saveFailed, false);
  assert.equal(parseSessionBindings(storage.getItem(SESSION_BINDINGS_KEY)).a, 'work');
  const snapshot = store.getSnapshot(); store.bind('a', 'work');
  assert.strictEqual(store.getSnapshot(), snapshot);
  store.dispose();
});

test('damaged bindings preserve the legacy anchor and never read inherited redirects', () => {
  for (const raw of ['{', '[]', 'null', '42', '{"a":null,"b":3," ":"x"}']) {
    assert.equal(tileSessionId(parseSessionBindings(raw), 'a'), 'a');
  }
  const targets = parseSessionBindings('{"__proto__":"safe","a":"work"}');
  assert.equal(Object.getPrototypeOf(targets), null);
  assert.equal(tileSessionId(targets, '__proto__'), 'safe');
  assert.equal(tileSessionId(Object.create({ inherited: 'wrong' }), 'inherited'), 'inherited');
});


test('joining after another tab writes preserves its order, root binding and resized width before storage events arrive', () => {
  const { events, storage } = fixture();
  const first = [createOrderStore(() => storage, events), createSessionBindingStore(() => storage, events), createSizingStore(() => storage, events)];
  const second = [createOrderStore(() => storage, events), createSessionBindingStore(() => storage, events), createSizingStore(() => storage, events)];
  first[0].prepend('a'); first[1].bind('a', 'work-a');
  first[2].save({ columns: {}, rows: {}, spans: {}, paneWidths: { a: 900 } });
  assert.deepEqual(second[0].getSnapshot().order, []);
  for (const store of second) store.sync();
  second[0].prepend('b'); second[1].bind('b', 'work-b');
  const sizing = second[2].getSnapshot().sizing;
  second[2].save({ ...sizing, paneWidths: { ...sizing.paneWidths, b: 380 } });
  for (const store of first) store.sync();
  assert.deepEqual(first[0].getSnapshot().order, ['b', 'a']);
  assert.equal(first[1].getSnapshot().targets.a, 'work-a');
  assert.equal(first[1].getSnapshot().targets.b, 'work-b');
  assert.equal(first[2].getSnapshot().sizing.paneWidths.a, 900);
  assert.equal(first[2].getSnapshot().sizing.paneWidths.b, 380);
  for (const store of [...first, ...second]) store.dispose();
});

test('pre-join sync does not discard unsaved memory state or create updates for unchanged storage', () => {
  const { events, storage } = fixture();
  const normal = [createOrderStore(() => storage, events), createSessionBindingStore(() => storage, events), createSizingStore(() => storage, events)];
  for (const store of normal) {
    const before = store.getSnapshot(); store.sync(); assert.strictEqual(store.getSnapshot(), before); store.dispose();
  }
  const blocked = { getItem: storage.getItem, setItem: () => { throw new Error('quota'); } };
  const stores = [createOrderStore(() => blocked, events), createSessionBindingStore(() => blocked, events), createSizingStore(() => blocked, events)];
  stores[0].prepend('memory'); stores[1].bind('memory', 'work');
  stores[2].save({ columns: {}, rows: {}, spans: {}, paneWidths: { memory: 800 } });
  for (const store of stores) {
    const before = store.getSnapshot(); assert.equal(before.saveFailed, true);
    store.sync(); assert.strictEqual(store.getSnapshot(), before); store.dispose();
  }
});
