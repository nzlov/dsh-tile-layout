import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOrderStore, isFileTransfer, moveBy, moveTo, paneColumns, parseOrder, sessionAvailability, sessionPickerChoices, STORAGE_KEY, swipeDirection, PANEL_VIEW_KEY, rememberTilePanel, createDefaultTileSession } from '../src/state.js';

const fixture = () => {
  const data = new Map();
  const events = new EventTarget();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const change = (key, storageArea = storage) => events.dispatchEvent(Object.assign(new Event('storage'), { key, storageArea }));
  return { events, storage, change };
};

test('invalid or legacy storage data cannot create duplicate panes', () => {
  assert.deepEqual(parseOrder('{'), []);
  assert.deepEqual(parseOrder(null), []);
  assert.deepEqual(parseOrder('{"order":["a"]}'), []);
  assert.deepEqual(parseOrder('["a","b","a",3,null,"  "]'), ['a', 'b']);
});

test('drop and keyboard moves preserve order and are no-ops for absent or boundary items', () => {
  const order = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveTo(order, 'a', 'c'), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveTo(order, 'd', 'b'), ['a', 'd', 'b', 'c']);
  assert.deepEqual(moveBy(order, 'c', -2), ['c', 'a', 'b', 'd']);
  assert.strictEqual(moveBy(order, 'd', 1), order);
  assert.strictEqual(moveTo(order, 'missing', 'b'), order);
  assert.strictEqual(moveTo(order, 'a', 'a'), order);
  assert.deepEqual(order, ['a', 'b', 'c', 'd']);
});

test('adding, removing and reordering survive recreation of the browser store', () => {
  const { storage, events } = fixture();
  const store = createOrderStore(() => storage, events);
  let notified = 0;
  const stop = store.subscribe(() => notified++);
  store.toggle('a'); store.toggle('b'); store.toggle('c'); store.move('c', 'a'); store.toggle('b');
  assert.equal(notified, 5);
  stop();
  store.dispose();
  const reloaded = createOrderStore(() => storage, events);
  assert.deepEqual(reloaded.getSnapshot(), { order: ['c', 'a'], saveFailed: false });
  reloaded.dispose();
});

test('other tabs update the local order, but unrelated changes and disposal do not', () => {
  const { storage, events, change } = fixture();
  const store = createOrderStore(() => storage, events);
  const initial = store.getSnapshot();
  storage.setItem(STORAGE_KEY, '["b","a"]');
  change('unrelated');
  change(STORAGE_KEY, {});
  assert.strictEqual(store.getSnapshot(), initial);
  change(STORAGE_KEY);
  assert.deepEqual(store.getSnapshot().order, ['b', 'a']);
  store.dispose();
  storage.setItem(STORAGE_KEY, '["c"]');
  change(STORAGE_KEY);
  assert.deepEqual(store.getSnapshot().order, ['b', 'a']);
});

test('storage errors keep the current interaction usable and report loss of persistence', () => {
  const { storage, events } = fixture();
  let blocked = true;
  const store = createOrderStore(() => {
    if (blocked) throw new Error('disabled');
    return storage;
  }, events);
  assert.equal(store.getSnapshot().saveFailed, true);
  store.toggle('a');
  assert.deepEqual(store.getSnapshot(), { order: ['a'], saveFailed: true });
  blocked = false;
  store.toggle('b');
  assert.deepEqual(store.getSnapshot(), { order: ['a', 'b'], saveFailed: false });
  assert.deepEqual(parseOrder(storage.getItem(STORAGE_KEY)), ['a', 'b']);
  store.dispose();
});

test('only sufficiently horizontal swipes switch panes', () => {
  assert.equal(swipeDirection(-85, 8), 1);
  assert.equal(swipeDirection(85, -8), -1);
  assert.equal(swipeDirection(60, 0), 0);
  assert.equal(swipeDirection(85, 70), 0);
  assert.equal(swipeDirection(0, 100), 0);
});

test('the file-drop guard does not classify tile reorder or text as a file gesture', () => {
  assert.equal(isFileTransfer(['text/plain', 'Files']), true);
  assert.equal(isFileTransfer(['application/x-dsh-file']), true);
  assert.equal(isFileTransfer(['application/x-dsh-session-tile']), false);
  assert.equal(isFileTransfer(['text/plain', 'text/uri-list']), false);
  assert.equal(isFileTransfer(undefined), false);
});

test('column count follows the actual pane width and number of open tiles', () => {
  assert.equal(paneColumns(330, 4), 1);
  assert.equal(paneColumns(691, 4), 1);
  assert.equal(paneColumns(692, 4), 2);
  assert.equal(paneColumns(1280, 8), 3);
  assert.equal(paneColumns(1800, 2), 2);
  assert.equal(paneColumns(2200, 12), 4);
});

test('adding a newly created or reused blank never removes an existing tile', () => {
  const { storage, events } = fixture();
  const store = createOrderStore(() => storage, events);
  store.include('existing'); store.include('new');
  const before = store.getSnapshot();
  store.include('existing'); store.include('new');
  assert.strictEqual(store.getSnapshot(), before);
  assert.deepEqual(store.getSnapshot().order, ['existing', 'new']);
  store.dispose();
});

function layoutFixture() {
  let state = { activePanelId: null };
  const listeners = new Set();
  return {
    panelInfo: { getSnapshot: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } },
    selectPanel(id) { state = { activePanelId: id }; for (const listener of listeners) listener(); },
  };
}

test('F5 restores an active tile panel without overwriting its flag with the initial null state', () => {
  const { storage } = fixture();
  const first = layoutFixture();
  const off = rememberTilePanel(first, () => storage, 'tiles');
  assert.equal(storage.getItem(PANEL_VIEW_KEY), '0');
  first.selectPanel('tiles');
  assert.equal(storage.getItem(PANEL_VIEW_KEY), '1');
  off();
  const reloaded = layoutFixture();
  const stop = rememberTilePanel(reloaded, () => storage, 'tiles');
  assert.equal(reloaded.panelInfo.getSnapshot().activePanelId, 'tiles');
  assert.equal(storage.getItem(PANEL_VIEW_KEY), '1');
  stop();
});

test('explicitly leaving tiles clears restoration and does not override other panels', () => {
  const { storage } = fixture();
  const layout = layoutFixture();
  const off = rememberTilePanel(layout, () => storage, 'tiles');
  layout.selectPanel('tiles'); layout.selectPanel('plugins');
  assert.equal(storage.getItem(PANEL_VIEW_KEY), '0');
  off();
  const reloaded = layoutFixture();
  const stop = rememberTilePanel(reloaded, () => storage, 'tiles');
  assert.equal(reloaded.panelInfo.getSnapshot().activePanelId, null);
  stop();
});

test('disposal before main removal preserves the active flag for HMR and tab-local reloads', () => {
  const { storage } = fixture();
  const layout = layoutFixture();
  const off = rememberTilePanel(layout, () => storage, 'tiles');
  layout.selectPanel('tiles'); off(); layout.selectPanel(null);
  assert.equal(storage.getItem(PANEL_VIEW_KEY), '1');
  const otherStorage = fixture().storage;
  const otherTab = layoutFixture();
  const stop = rememberTilePanel(otherTab, () => otherStorage, 'tiles');
  assert.equal(otherTab.panelInfo.getSnapshot().activePanelId, null);
  stop();
});

test('restricted session storage does not prevent normal panel navigation', () => {
  const layout = layoutFixture();
  const stop = rememberTilePanel(layout, () => { throw new Error('restricted'); }, 'tiles');
  assert.doesNotThrow(() => { layout.selectPanel('tiles'); layout.selectPanel(null); });
  stop();
});

test('unknown, archived, old-format and subagent sessions do not open as tiles', () => {
  assert.equal(sessionAvailability(undefined, false, false), 'loading');
  assert.equal(sessionAvailability(undefined, false, true), 'unavailable');
  assert.equal(sessionAvailability({ origin: 'subagent' }, false, true), 'unavailable');
  assert.equal(sessionAvailability({ formatStatus: 'migration-required' }, false, true), 'migration');
  assert.equal(sessionAvailability({}, true, true), 'archived');
  assert.equal(sessionAvailability({ blank: true }, false, true), null);
});


test('new tiles use the actual default workspace and create fresh when no reusable catalogue is available', async () => {
  const requests = [];
  const ctx = {
    workspaces: { initializeDefault: async () => ({ workspaceId: 'default-workspace' }) },
    sessions: { create: async input => { requests.push(input); return `fresh-${requests.length}`; } },
  };
  assert.equal(await createDefaultTileSession(ctx), 'fresh-1');
  assert.equal(await createDefaultTileSession(ctx), 'fresh-2');
  assert.deepEqual(requests, [{ workspaceId: 'default-workspace' }, { workspaceId: 'default-workspace' }]);
  assert.ok(requests.every(input => !Object.hasOwn(input, 'sessionId') && !Object.hasOwn(input, 'cwd')));
});

test('legacy profiles use Host default creation, never a guessed or current workspace', async () => {
  let request;
  const id = await createDefaultTileSession({
    workspaces: { initializeDefault: async () => undefined },
    sessions: { create: async input => { request = input; return 'fresh'; } },
  });
  assert.equal(id, 'fresh');
  assert.deepEqual(request, {});
});

test('failure to prepare the default workspace does not silently create elsewhere', async () => {
  let creates = 0;
  await assert.rejects(createDefaultTileSession({
    workspaces: { initializeDefault: async () => { throw new Error('workspace unavailable'); } },
    sessions: { create: async () => { creates++; return 'wrong'; } },
  }), /workspace unavailable/);
  assert.equal(creates, 0);
});

test('new layouts are prepended uniquely and remain first after browser reload', () => {
  const { storage, events } = fixture();
  const store = createOrderStore(() => storage, events);
  store.include('old-a'); store.include('old-b'); store.prepend('new');
  assert.deepEqual(store.getSnapshot().order, ['new', 'old-a', 'old-b']);
  const snapshot = store.getSnapshot();
  store.prepend('new');
  assert.strictEqual(store.getSnapshot(), snapshot);
  store.prepend('old-b');
  assert.deepEqual(store.getSnapshot().order, ['old-b', 'new', 'old-a']);
  store.dispose();
  const reloaded = createOrderStore(() => storage, events);
  assert.deepEqual(reloaded.getSnapshot().order, ['old-b', 'new', 'old-a']);
  reloaded.dispose();
});


test('choosing an existing session joins at the left and toggles off without duplicates', () => {
  const { storage, events } = fixture();
  const store = createOrderStore(() => storage, events);
  store.include('old-a'); store.include('old-b');
  store.toggleFront('chosen');
  assert.deepEqual(store.getSnapshot().order, ['chosen', 'old-a', 'old-b']);
  store.toggleFront('chosen');
  assert.deepEqual(store.getSnapshot().order, ['old-a', 'old-b']);
  store.toggleFront('old-b'); store.toggleFront('old-b');
  assert.deepEqual(store.getSnapshot().order, ['old-b', 'old-a']);
  store.dispose();
  const reloaded = createOrderStore(() => storage, events);
  assert.deepEqual(reloaded.getSnapshot().order, ['old-b', 'old-a']);
  reloaded.dispose();
});


test('closing an unused new card removes its blank from picker candidates without deleting metadata', () => {
  const byId = { unused: { blank: true }, working: { blank: false } };
  const ids = ['unused', 'working'];
  assert.deepEqual(sessionPickerChoices(['unused'], {}, ids, byId, new Set(), true),
    [{ anchor: 'unused', sessionId: 'unused' }, { sessionId: 'working' }]);
  assert.deepEqual(sessionPickerChoices([], {}, ids, byId, new Set(), true), [{ sessionId: 'working' }]);
  assert.deepEqual(byId.unused, { blank: true });
});

test('old accumulated blank rows are hidden while legacy and started conversations remain selectable', () => {
  const byId = { a: { blank: true }, b: { blank: true }, historical: {}, working: { blank: false, running: true } };
  assert.deepEqual(sessionPickerChoices([], {}, Object.keys(byId), byId, new Set(), true),
    [{ sessionId: 'historical' }, { sessionId: 'working' }]);
  byId.a = { blank: false };
  assert.equal(sessionPickerChoices([], {}, Object.keys(byId), byId, new Set(), true)[0].sessionId, 'a');
});

test('picker still shows selected blank and unavailable cards so they can be unchecked', () => {
  const byId = { blank: { blank: true }, archived: { blank: false } };
  assert.deepEqual(sessionPickerChoices(['anchor', 'missing', 'archived'], { anchor: 'blank' },
    ['blank', 'archived'], byId, new Set(['archived']), true),
    [{ anchor: 'anchor', sessionId: 'blank' }, { anchor: 'missing', sessionId: 'missing' }, { anchor: 'archived', sessionId: 'archived' }]);
});

test('picker respects actual bound roots and retains archive/subagent/migration filters', () => {
  const byId = { oldBlank: { blank: true }, working: { blank: false }, child: { blank: false, origin: 'subagent' },
    archived: { blank: false }, legacy: { blank: false, formatStatus: 'migration-required' } };
  assert.deepEqual(sessionPickerChoices(['oldBlank'], { oldBlank: 'working' }, Object.keys(byId), byId, new Set(['archived']), true),
    [{ anchor: 'oldBlank', sessionId: 'working' }]);
});
