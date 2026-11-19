import { swipeDirection } from './state.js';

// Each pane runs the existing, authenticated DSH page in its own browser realm.
// No copied header, Slot ownership bypass, or replacement Sidebar controller.
export const TILE_FRAME_PARAM = 'dshTileSession';
export const TILE_FRAME_CHANNEL = 'dsh-session-tiles:native:v1';

export function nativeFrameUrl(href, sessionId, token) {
  const url = new URL(href);
  url.hash = '';
  // Reuse this server/path, not auth or inspector parameters from the outer URL.
  url.search = '';
  url.searchParams.set(TILE_FRAME_PARAM, sessionId);
  url.searchParams.set('dshTileToken', token);
  return url.href;
}

export function nativeFrameTarget(win) {
  try {
    if (win.parent === win) return undefined;
    const url = new URL(win.location.href);
    const sessionId = url.searchParams.get(TILE_FRAME_PARAM);
    const token = url.searchParams.get('dshTileToken');
    const frame = win.frameElement;
    if (!sessionId || !token || frame?.dataset.dshSessionTile !== sessionId
      || frame.dataset.dshTileToken !== token) return undefined;
    return { sessionId, token };
  } catch { return undefined; }
}

// The native navigation store persists this one key. Isolate it *only* in this
// iframe realm, so selecting a pane never overwrites the outer page's last
// session. Theme, plugin settings, native drafts, and all other keys stay native.
// Storage.prototype is realm-local; no parent prototype or saved value changes.
export function isolateTileNavigation(proto, storage, sessionId) {
  const key = 'dsh.sessions.current';
  let selected = JSON.stringify({ sessionId });
  const restorers = [];
  try {
    for (const method of ['getItem', 'setItem', 'removeItem']) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, method);
      if (typeof descriptor?.value !== 'function') throw new Error('Navigation storage cannot be isolated');
      const original = descriptor.value;
      function localNavigation(name, value) {
        if (this !== storage || name !== key) return original.apply(this, arguments);
        if (method === 'getItem') return selected;
        selected = method === 'removeItem' ? null : String(value);
      }
      Object.defineProperty(proto, method, { ...descriptor, value: localNavigation });
      restorers.push(() => {
        if (proto[method] === localNavigation) Object.defineProperty(proto, method, descriptor);
      });
    }
  } catch (error) {
    for (const restore of restorers.reverse()) restore();
    throw error;
  }
  return () => { for (const restore of restorers.reverse()) restore(); };
}

export function isNativeFrameMessage(event, frameWindow, origin, token, sessionId) {
  return !!frameWindow && event.source === frameWindow && event.origin === origin
    && event.data?.channel === TILE_FRAME_CHANNEL && event.data.token === token
    && (sessionId === undefined || event.data.sessionId === sessionId);
}

export function nativeSessionRoot(snapshot, id) {
  if (typeof id !== 'string' || !snapshot?.byId || !Object.hasOwn(snapshot.byId, id)) return undefined;
  const row = snapshot.byId[id];
  return row && typeof row === 'object' ? row.origin !== 'subagent' : undefined;
}

export function nativeTileColumns(template) {
  if (typeof template !== 'string' || !/^\s*\d+(?:\.\d+)?px\s+/.test(template)) return undefined;
  return template.replace(/^\s*\d+(?:\.\d+)?px\s+/, '0px ');
}

export const NATIVE_TILE_CHROME_CSS = `
    /* The outer page owns the shared wallpaper/filter. Disable only embedded
       document canvases and their wallpaper pseudos; keep control surfaces. */
    html:root[data-dsh-native-tile],
    html[data-dsh-native-tile] body,
    html[data-dsh-native-tile] [data-dsh-boot],
    html[data-dsh-native-tile] [data-dsh-tile-frame],
    html[data-dsh-native-tile] [data-dsh-tile-frame] > div:has([data-slot="main"]),
    html[data-dsh-native-tile] [data-phase]:has(> [data-slot="conversation.header"]),
    html[data-dsh-native-tile] [data-conversation-content] {
      background: transparent !important;
    }
    html:root[data-dsh-native-tile]::before,
    html:root[data-dsh-native-tile]::after,
    html[data-dsh-native-tile] [data-dsh-boot]::before,
    html[data-dsh-native-tile] [data-dsh-boot]::after {
      content: none !important;
      display: none !important;
    }
    html[data-dsh-native-tile] [data-dsh-tile-frame] {
      grid-template-columns: var(--dsh-st-native-columns) !important;
      --dsh-frame-leading-clearance: 0px !important;
    }
    /* Hide only the native breadcrumb title, not its adjacent mode/cost/task
       actions, utilities, corner control, or the View tabs. */
    html[data-dsh-native-tile] [data-slot="conversation.session.header"]
      nav:has(+ div > [data-slot="conversation.session.header.actions"]) { display: none !important; }
    html[data-dsh-native-tile] [data-dsh-tile-nav],
    html[data-dsh-native-tile] [data-dsh-tile-frame] [data-shell-leading],
    html[data-dsh-native-tile] [data-dsh-tile-frame] [data-sidebar-mask],
    html[data-dsh-native-tile] [data-dsh-tile-frame] [data-side='sidebar'] { display: none !important; }
`;

export function installNativeTileChrome(win) {
  const doc = win.document;
  const style = doc.createElement('style');
  style.textContent = NATIVE_TILE_CHROME_CSS;
  doc.documentElement.setAttribute('data-dsh-native-tile', '');
  doc.head.append(style);
  let frame, navigation, measure;
  function columns() {
    const next = nativeTileColumns(frame.style.gridTemplateColumns);
    if (next && frame.style.getPropertyValue('--dsh-st-native-columns') !== next) {
      frame.style.setProperty('--dsh-st-native-columns', next);
    }
  }
  function discover() {
    if (frame) return;
    const candidate = doc.querySelector('[data-rightbar-col]')?.parentElement;
    let left = candidate?.querySelector('[data-slot="sidebar"]');
    if (!candidate || !left) return;
    while (left.parentElement && left.parentElement !== candidate) left = left.parentElement;
    if (left.parentElement !== candidate) return;
    frame = candidate; navigation = left;
    frame.setAttribute('data-dsh-tile-frame', '');
    navigation.setAttribute('data-dsh-tile-nav', '');
    columns();
    search.disconnect();
    measure = new win.MutationObserver(columns);
    // Only the native frame's inline geometry matters, not streaming messages.
    measure.observe(frame, { attributes: true, attributeFilter: ['style'] });
  }
  const search = new win.MutationObserver(discover);
  search.observe(doc.documentElement, { childList: true, subtree: true });
  discover();
  return () => {
    search.disconnect(); measure?.disconnect(); style.remove();
    frame?.removeAttribute('data-dsh-tile-frame');
    frame?.style.removeProperty('--dsh-st-native-columns');
    navigation?.removeAttribute('data-dsh-tile-nav');
    doc.documentElement.removeAttribute('data-dsh-native-tile');
  };
}

export function queueNativeOpen(read, open, schedule = queueMicrotask) {
  let queued = false, stopped = false, opened = false;
  function check() {
    if (queued || stopped || opened || read().phase !== 'ready') return;
    queued = true;
    schedule(() => {
      queued = false;
      if (stopped || opened || read().phase !== 'ready') return;
      opened = true;
      open();
    });
  }
  return { check, dispose: () => { stopped = true; } };
}

export function installNativeTilePage(ctx, React, win, target) {
  let ready = false, currentSessionId = target.sessionId, currentIsRootSession, failed = false;
  const send = (type, extra = {}) => {
    if (type === 'ready') { ready = true; failed = false; }
    if (type === 'error') { failed = true; ready = false; }
    if (type === 'navigate') {
      currentSessionId = extra.nextSessionId;
      currentIsRootSession = nativeSessionRoot(ctx.sessions.list.getSnapshot(), currentSessionId);
    } else if (type === 'ready') {
      const hint = nativeSessionRoot(ctx.sessions.list.getSnapshot(), currentSessionId);
      if (hint !== undefined) currentIsRootSession = hint;
    }
    if (typeof extra.isRootSession === 'boolean') currentIsRootSession = extra.isRootSession;
    win.parent.postMessage({
      channel: TILE_FRAME_CHANNEL, token: target.token, type, sessionId: target.sessionId,
      currentSessionId, ...extra, isRootSession: currentIsRootSession,
    }, win.location.origin);
  };
  ctx.effect(() => installNativeTileChrome(win), 'session tiles: embedded shell chrome');
  ctx.effect(() => {
    function probe(event) {
      if (event.source !== win.parent || event.origin !== win.location.origin
        || event.data?.channel !== TILE_FRAME_CHANNEL || event.data.token !== target.token
        || event.data.type !== 'probe') return;
      if (ready) send('ready');
      else if (failed) send('error');
    }
    win.addEventListener('message', probe);
    return () => win.removeEventListener('message', probe);
  }, 'session tiles: repeatable readiness handshake');
  ctx.effect(() => isolateTileNavigation(win.Storage.prototype, win.localStorage, target.sessionId),
    'session tiles: isolate embedded navigation');
  ctx.effect(() => {
    const boot = queueNativeOpen(() => ctx.sessions.list.getSnapshot(), () => {
      if (!ctx.sessions.list.getSnapshot().byId[target.sessionId]) { send('error'); return; }
      try { ctx.uiWorkspace.openSession(target.sessionId); }
      catch (error) {
        console.warn('[dsh-tile-layout] Could not open native session', error);
        send('error');
      }
    });
    // Native restoration itself publishes retain counts before assigning its
    // mainReference. Never re-enter it from a synchronous list notification.
    const offList = ctx.sessions.list.subscribe(boot.check);
    boot.check();
    return () => { boot.dispose(); offList(); send('reload'); };
  }, 'session tiles: native main session');
  // A committed native shell is the readiness boundary, not iframe load or
  // the return from openSession. Do not expose a restored, unrelated session.
  const current = ctx.get('uiSession')?.adapter.current;
  if (!current) throw new Error('Native session scope is unavailable');
  let bound = false, last = target.sessionId, lastRoot;
  function NativeStatus({ useStore }) {
    const layout = useStore?.(state => state.layoutInfo);
    const binding = React.useSyncExternalStore(current.subscribe, current.getSnapshot);
    const sessionList = React.useSyncExternalStore(ctx.sessions.list.subscribe, ctx.sessions.list.getSnapshot);
    const isRootSession = nativeSessionRoot(sessionList, binding.key);
    React.useLayoutEffect(() => {
      // Keep the native left drawer genuinely closed, including after its
      // keyboard shortcut, so it cannot make the conversation inert offscreen.
      if (layout && (layout.viewportWidth < 1024 ? layout.narrowExpanded : layout.sidebar !== 0)) {
        ctx.layout.toggleSidebar();
      }
    }, [layout?.sidebar, layout?.narrowExpanded, layout?.viewportWidth]);
    React.useLayoutEffect(() => {
      const id = binding.key;
      if (!bound) {
        if (id !== target.sessionId) return;
        bound = true; last = id; lastRoot = isRootSession;
        send('ready', { isRootSession });
      } else if (typeof id === 'string' && (id !== last || isRootSession !== lastRoot)) {
        last = id; lastRoot = isRootSession;
        send('navigate', { nextSessionId: id, isRootSession });
      }
    }, [binding.key, isRootSession]);
    return null;
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'dsh-session-tiles-native-status',
    ...(ctx.slots.entriesOfSlot('root')[0]?.store && { store: ctx.slots.entriesOfSlot('root')[0].store }),
  }, NativeStatus));
  ctx.effect(() => {
    // Forward only intentional horizontal swipes in non-interactive chat
    // space. Native inputs, menus, sidebars and horizontally scrolling code
    // keep their gestures. The outer page decides whether it is in mobile mode.
    let start;
    function begin(event) {
      start = undefined;
      if (event.touches.length !== 1) return;
      const target = event.target;
      if (!(target instanceof win.Element) || !target.closest('[data-conversation-session]')
        || target.closest('a,button,input,textarea,select,[contenteditable],[role=button],[role=menu],pre,table,[data-rightbar-col]')) return;
      for (let node = target; node; node = node.parentElement) {
        if (node.scrollWidth > node.clientWidth + 3 && /auto|scroll/.test(win.getComputedStyle(node).overflowX)) return;
      }
      const point = event.touches[0];
      start = { id: point.identifier, x: point.clientX, y: point.clientY };
    }
    function end(event) {
      const previous = start; start = undefined;
      if (!previous || event.touches.length) return;
      const point = Array.from(event.changedTouches).find(value => value.identifier === previous.id);
      const direction = point && swipeDirection(point.clientX - previous.x, point.clientY - previous.y);
      if (direction) send('swipe', { direction });
    }
    const cancel = () => { start = undefined; };
    win.document.addEventListener('touchstart', begin, { passive: true });
    win.document.addEventListener('touchend', end, { passive: true });
    win.document.addEventListener('touchcancel', cancel);
    return () => {
      win.document.removeEventListener('touchstart', begin);
      win.document.removeEventListener('touchend', end);
      win.document.removeEventListener('touchcancel', cancel);
    };
  }, 'session tiles: native touch bridge');
}

export function nativeFrameToken(random = globalThis.crypto) {
  if (typeof random?.randomUUID === 'function') return random.randomUUID();
  if (typeof random?.getRandomValues === 'function') {
    return Array.from(random.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  // Correlation only, never authentication: exact source and origin are also
  // required. Keep LAN HTTP compatible when randomUUID is unavailable.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

// Capture only when the component activates or an explicit load attempt changes.
// A durable binding update must never navigate the document that reported it.
export function nativeFrameLaunch(previous, attempt, sessionId, makeToken = nativeFrameToken) {
  if (previous?.attempt === attempt) return previous;
  return Object.freeze({ attempt, sessionId, token: makeToken() });
}

export function nativeReadyNeedsRetry(loadSessionId, desiredSessionId, actualSessionId) {
  return typeof desiredSessionId === 'string' && desiredSessionId !== loadSessionId
    && actualSessionId === loadSessionId;
}

export function createNativeFrame(React, Button) {
  const { createElement: h, useEffect, useRef, useState } = React;
  return function NativeFrame({ id, sessionId = id, title, t, onSwipe, onNavigate }) {
    const ref = useRef(null);
    const launch = useRef(null);
    const desiredSession = useRef(sessionId);
    desiredSession.current = sessionId;
    const callbacks = useRef({ onSwipe, onNavigate });
    callbacks.current = { onSwipe, onNavigate };
    const [attempt, retry] = useState(0);
    const [status, setStatus] = useState('loading');
    const [activated, activate] = useState(false);
    if (activated) launch.current = nativeFrameLaunch(launch.current, attempt, sessionId);
    const container = useRef(null);
    function requestReady() {
      if (launch.current) ref.current?.contentWindow?.postMessage({ channel: TILE_FRAME_CHANNEL, token: launch.current.token, type: 'probe' }, window.location.origin);
    }
    useEffect(() => {
      const bounds = container.current?.getBoundingClientRect();
      if ((bounds && bounds.width > 0 && bounds.height > 0 && bounds.right > 0 && bounds.left < window.innerWidth
        && bounds.bottom > 0 && bounds.top < window.innerHeight) || typeof IntersectionObserver !== 'function') {
        activate(true); return;
      }
      const observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) { activate(true); observer.disconnect(); }
      }, { rootMargin: '400px' });
      if (container.current) observer.observe(container.current);
      return () => observer.disconnect();
    }, []);
    useEffect(() => {
      if (!activated) return;
      const load = launch.current;
      setStatus('loading');
      // Ready is a repeatable handshake. A cached frame may announce itself
      // before this listener commits; probe on load and briefly until confirmed.
      const heartbeat = window.setInterval(requestReady, 1000);
      const timeout = window.setTimeout(() => {
        window.clearInterval(heartbeat);
        setStatus(value => value === 'loading' ? 'timeout' : value);
      }, 30000);
      function message(event) {
        if (launch.current !== load
          || !isNativeFrameMessage(event, ref.current?.contentWindow, window.location.origin, load.token, load.sessionId)) return;
        const data = event.data;
        if (data.type === 'ready') {
          const actual = typeof data.currentSessionId === 'string' && data.currentSessionId ? data.currentSessionId : load.sessionId;
          window.clearTimeout(timeout); window.clearInterval(heartbeat);
          // A document-only reload still uses its frozen URL. If that URL is
          // now obsolete, reopen the saved root instead of persisting the old
          // blank over it. A live document reporting its new root stays loaded.
          if (nativeReadyNeedsRetry(load.sessionId, desiredSession.current, actual)) {
            setStatus('loading'); retry(value => value + 1); return;
          }
          setStatus('ready');
          callbacks.current.onNavigate?.(actual, typeof data.isRootSession === 'boolean' ? data.isRootSession : undefined);
        }
        else if (data.type === 'error') { window.clearTimeout(timeout); window.clearInterval(heartbeat); setStatus('error'); }
        else if (data.type === 'reload') retry(value => value + 1);
        else if (data.type === 'swipe' && (data.direction === -1 || data.direction === 1)) callbacks.current.onSwipe?.(data.direction);
        else if (data.type === 'navigate' && typeof data.nextSessionId === 'string' && data.nextSessionId) callbacks.current.onNavigate?.(data.nextSessionId,
          typeof data.isRootSession === 'boolean' ? data.isRootSession : undefined);
      }
      window.addEventListener('message', message);
      requestReady();
      return () => { window.clearTimeout(timeout); window.clearInterval(heartbeat); window.removeEventListener('message', message); };
    }, [id, attempt, activated]);
    return h('div', { ref: container, className: 'dsh-st-native-frame', 'aria-busy': status === 'loading' || undefined },
      activated && h('iframe', {
        key: `${id}:${attempt}`, ref, title, name: `dsh-session-tile:${id}`, onLoad: requestReady,
        src: nativeFrameUrl(window.location.href, launch.current.sessionId, launch.current.token),
        'data-dsh-session-tile': launch.current.sessionId, 'data-dsh-tile-token': launch.current.token,
        allow: 'clipboard-read; clipboard-write; fullscreen; display-capture',
        className: status === 'ready' ? 'dsh-st-frame-ready' : undefined,
      }),
      status !== 'ready' && h('div', { className: 'dsh-st-frame-state', role: 'status' },
        h('span', null, t(status === 'loading' ? 'loading' : 'nativeLoadError')),
        status !== 'loading' && h(Button, { onClick: () => retry(value => value + 1) }, t('retry'))));
  };
}
