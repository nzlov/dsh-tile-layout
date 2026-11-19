// Legacy storage keys are intentionally stable across the dsh-tile-layout rename.
export const STORAGE_KEY = 'dsh-session-tiles:order:v1';

export function parseOrder(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter(id => typeof id === 'string' && id.trim()))]
      : [];
  } catch {
    return [];
  }
}

export function moveTo(order, id, targetId) {
  const from = order.indexOf(id);
  const to = order.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return order;
  const next = order.slice();
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

export function moveBy(order, id, offset) {
  const index = order.indexOf(id);
  return index < 0 ? order : moveTo(order, id, order[index + offset]);
}

export function swipeDirection(dx, dy) {
  return Math.abs(dx) >= 64 && Math.abs(dx) > Math.abs(dy) * 1.5 ? (dx < 0 ? 1 : -1) : 0;
}

export function isFileTransfer(types) {
  return Array.from(types ?? []).some(type => type === 'Files' || type === 'application/x-dsh-file');
}

export const SESSION_BINDINGS_KEY = 'dsh-session-tiles:session-bindings:v1';
const bindingIdValid = id => typeof id === 'string' && id.trim().length > 0;

export function parseSessionBindings(raw) {
  const targets = Object.create(null);
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return targets;
    for (const [anchor, target] of Object.entries(value)) {
      if (bindingIdValid(anchor) && bindingIdValid(target)) targets[anchor] = target;
    }
  } catch { /* Unavailable storage has no redirects. */ }
  return targets;
}

export function tileSessionId(targets, anchor) {
  return Object.hasOwn(targets, anchor) && bindingIdValid(targets[anchor]) ? targets[anchor] : anchor;
}

export function findSessionTile(order, targets, sessionId) {
  return order.find(anchor => tileSessionId(targets, anchor) === sessionId);
}

export function chooseSessionTile(order, targets, sessionId, freshAnchor) {
  const existing = findSessionTile(order, targets, sessionId);
  if (existing !== undefined) return existing;
  const reusable = Object.keys(targets).find(anchor => !order.includes(anchor) && tileSessionId(targets, anchor) === sessionId);
  if (reusable !== undefined) return reusable;
  const redirectedAnchor = Object.hasOwn(targets, sessionId) && tileSessionId(targets, sessionId) !== sessionId;
  return order.includes(sessionId) || redirectedAnchor ? freshAnchor() : sessionId;
}

export function canRememberRootSession(id, hint, byId) {
  if (!bindingIdValid(id) || hint === false) return false;
  const row = Object.hasOwn(byId, id) ? byId[id] : undefined;
  if (row?.origin === 'subagent') return false;
  return hint === true || row !== undefined;
}

export function createSessionBindingStore(getStorage, events) {
  const listeners = new Set();
  let snapshot = { targets: Object.create(null), saveFailed: false };
  try { snapshot.targets = parseSessionBindings(getStorage().getItem(SESSION_BINDINGS_KEY)); }
  catch { snapshot.saveFailed = true; }
  function publish(targets, saveFailed) {
    snapshot = { targets, saveFailed };
    for (const notify of listeners) notify();
  }
  function storageChanged(event) {
    if (event.key !== SESSION_BINDINGS_KEY && event.key !== null) return;
    try {
      const storage = getStorage();
      if (event.storageArea === storage) publish(parseSessionBindings(storage.getItem(SESSION_BINDINGS_KEY)), false);
    } catch { publish(snapshot.targets, true); }
  }
  events.addEventListener('storage', storageChanged);
  return {
    getSnapshot: () => snapshot,
    subscribe(notify) { listeners.add(notify); return () => listeners.delete(notify); },
    sync() {
      if (snapshot.saveFailed) return; // Do not roll back unsaved local work.
      try {
        const targets = parseSessionBindings(getStorage().getItem(SESSION_BINDINGS_KEY));
        const keys = Object.keys(targets);
        if (keys.length !== Object.keys(snapshot.targets).length || keys.some(key => targets[key] !== snapshot.targets[key])) publish(targets, false);
      } catch { publish(snapshot.targets, true); }
    },
    bind(anchor, sessionId) {
      if (!bindingIdValid(anchor) || !bindingIdValid(sessionId) || (snapshot.targets[anchor] === sessionId && !snapshot.saveFailed)) return;
      const targets = Object.assign(Object.create(null), snapshot.targets);
      targets[anchor] = sessionId;
      let saveFailed = false;
      try { getStorage().setItem(SESSION_BINDINGS_KEY, JSON.stringify(targets)); } catch { saveFailed = true; }
      publish(targets, saveFailed);
    },
    dispose() { events.removeEventListener('storage', storageChanged); listeners.clear(); },
  };
}

export const PANEL_VIEW_KEY = 'dsh-session-tiles:active-panel:v1';

export function reusableTileBlank(workspace, workspaceState, sessionState, occupied, agentPreset, bindingOf = () => undefined) {
  if (workspaceState?.phase !== 'ready' || sessionState?.phase !== 'ready') return undefined;
  const archived = new Set(workspaceState.archivedSessionIds);
  const members = new Set(workspaceState.items.flatMap(item => item.sessionIds));
  return sessionState.ids.find(id => {
    const row = Object.hasOwn(sessionState.byId, id) ? sessionState.byId[id] : undefined;
    if (!row || row.blank !== true || row.running || occupied.has(id)
      || sessionAvailability(row, archived.has(id), true) !== null) return false;
    if (Object.values(row.retainedBy ?? {}).some(count => count > 0)) return false;
    const live = bindingOf(id)?.session.getSnapshot();
    if (live && (!live.blank || live.running || live.promptAttempted || live.awaitingFirstTurn || live.pendingSubmissions?.length)) return false;
    const listed = row.projectionValues?.agentPreset;
    if (agentPreset !== undefined && typeof listed === 'string' && listed !== agentPreset) return false;
    // Registered defaults use exactly the native membership/directory test.
    // Legacy ungrouped blanks are only hints: the Host validates defaultCwd.
    return workspace ? row.cwd === workspace.path && workspace.sessionIds.includes(id) : !members.has(id);
  });
}

export async function createDefaultTileSession(ctx, getOccupied = () => new Set(), options = {}) {
  const workspace = await ctx.workspaces.initializeDefault();
  const request = { ...(workspace && { workspaceId: workspace.workspaceId }),
    ...(options.agentPreset !== undefined && { agentPreset: options.agentPreset }) };
  const candidate = reusableTileBlank(workspace, ctx.workspaces.list?.getSnapshot(), ctx.sessions.list?.getSnapshot(),
    getOccupied(), options.agentPreset, id => ctx.sessions.binding?.(id));
  let id;
  try { id = await ctx.sessions.create({ ...request, ...(candidate !== undefined && { sessionId: candidate }) }); }
  catch (error) {
    const failure = error?.rpcError;
    if (candidate === undefined || failure?.code !== 'session/conflict'
      || typeof failure.details?.requestedCwd !== 'string') throw error;
    // Legacy metadata cannot tell us the Host's current default directory.
    // Drop only the reuse hint; never replace that default with candidate.cwd.
    id = await ctx.sessions.create(request);
  }
  if (candidate !== undefined && id !== candidate) {
    // A cached blank may have begun work. Reconcile it just as native creation
    // does; only use the authoritative ID the Host actually returned.
    void ctx.sessions.refreshProjections?.(candidate).catch(error => console.warn('[dsh-tile-layout] Declined blank refresh failed', error));
  }
  if (getOccupied().has(id)) {
    // A different card claimed it while the request was in flight. Mint rather
    // than attach a second tile to that card, even without Web Locks support.
    id = await ctx.sessions.create(request);
    if (getOccupied().has(id)) throw new Error('New session was already claimed by another tile');
  }
  return id;
}

// sessionStorage is tab-local. Embedded native pages return before installing
// this policy, so their normal Session navigation cannot overwrite the marker.
export function rememberTilePanel(layout, getStorage, panelId) {
  let restore = false;
  try { restore = getStorage().getItem(PANEL_VIEW_KEY) === '1'; } catch { /* Memory-only navigation remains usable. */ }
  if (restore) layout.selectPanel(panelId);
  const save = () => {
    try { getStorage().setItem(PANEL_VIEW_KEY, layout.panelInfo.getSnapshot().activePanelId === panelId ? '1' : '0'); }
    catch { /* A restricted browser must not break panel navigation. */ }
  };
  const off = layout.panelInfo.subscribe(save);
  save();
  return off;
}

export function createOrderStore(getStorage, events) {
  const listeners = new Set();
  let snapshot = { order: [], saveFailed: false };
  try {
    snapshot.order = parseOrder(getStorage().getItem(STORAGE_KEY));
  } catch {
    snapshot.saveFailed = true;
  }
  function publish(order, saveFailed) {
    if (saveFailed === snapshot.saveFailed && order.length === snapshot.order.length
      && order.every((id, i) => id === snapshot.order[i])) return;
    snapshot = { order, saveFailed };
    for (const notify of listeners) notify();
  }
  function update(operation) {
    const order = operation(snapshot.order);
    if (order === snapshot.order) return;
    let saveFailed = false;
    try {
      getStorage().setItem(STORAGE_KEY, JSON.stringify(order));
    } catch {
      saveFailed = true;
    }
    publish(order, saveFailed);
  }
  function onStorage(event) {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    try {
      const storage = getStorage();
      if (event.storageArea === storage) publish(parseOrder(storage.getItem(STORAGE_KEY)), false);
    } catch {
      publish(snapshot.order, true);
    }
  }
  events.addEventListener('storage', onStorage);
  return {
    getSnapshot: () => snapshot,
    subscribe(notify) {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    sync() {
      if (snapshot.saveFailed) return;
      try { publish(parseOrder(getStorage().getItem(STORAGE_KEY)), false); }
      catch { publish(snapshot.order, true); }
    },
    include: id => update(order => order.includes(id) ? order : [...order, id]),
    prepend: id => update(order => order[0] === id ? order : [id, ...order.filter(value => value !== id)]),
    toggle: id => update(order => order.includes(id) ? order.filter(value => value !== id) : [...order, id]),
    toggleFront: id => update(order => order.includes(id) ? order.filter(value => value !== id) : [id, ...order]),
    move: (id, targetId) => update(order => moveTo(order, id, targetId)),
    step: (id, offset) => update(order => moveBy(order, id, offset)),
    dispose() { events.removeEventListener('storage', onStorage); listeners.clear(); },
  };
}

export function paneColumns(width, count) {
  return Math.max(1, Math.min(4, count, Math.floor((width + 12) / 352)));
}

export function sessionAvailability(row, archived, ready) {
  if (!ready && !row) return 'loading';
  if (archived) return 'archived';
  if (!row || row.origin === 'subagent') return 'unavailable';
  if (row.formatStatus === 'migration-required') return 'migration';
  return null;
}


// Match the native Workspace browser: an explicit tile may be blank, but an
// unselected blank is not a conversation to offer in the history picker.
export function sessionPickerChoices(order, targets, ids, byId, archived, ready) {
  const selected = new Set(order.map(anchor => tileSessionId(targets, anchor)));
  const available = ids.filter(id => {
    const row = Object.hasOwn(byId, id) ? byId[id] : undefined;
    return !selected.has(id) && sessionAvailability(row, archived.has(id), ready) === null && row.blank !== true;
  });
  return [...order.map(anchor => ({ anchor, sessionId: tileSessionId(targets, anchor) })),
    ...available.map(sessionId => ({ sessionId }))];
}
