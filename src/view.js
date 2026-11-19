export function createTilePlugin(React, css, dictionaries) {
  const { createElement: h, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;
  // Stable legacy panel identity preserves saved views across the package rename.
  const panel = 'dsh-session-tiles';
  const mobileQuery = '(max-width: 767px), (max-width: 950px) and (pointer: coarse)';
  const Splitter = createSplitter(React);
  const headerCss = `.dsh-st-toggle{display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}.dsh-st-toggle:hover,.dsh-st-toggle[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-brand-text)}.dsh-st-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}`;

  const paths = {
    tiles: 'M3 4.5h7.5v15H3z M13.5 4.5H21v15h-7.5z',
    tilesSelected: 'M3 4.5h7.5v15H3z M13.5 4.5H21v15h-7.5z M15.5 12l1.2 1.3 2.3-2.6',
    prev: 'm14.5 5.5-6.5 6.5 6.5 6.5',
    next: 'm9.5 5.5 6.5 6.5-6.5 6.5',
    up: 'm5.5 14.5 6.5-6.5 6.5 6.5',
    down: 'm5.5 9.5 6.5 6.5 6.5-6.5',
    close: 'M6 6l12 12M18 6 6 18',
    open: 'M13 4h7v7M20 4l-9 9M9 5H5v14h14v-4',
    grip: 'M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01',
    list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
    plus: 'M12 5v14M5 12h14',
    rightbar: 'M3.5 4.5h17v15h-17zM14.5 4.5v15M17.3 10h.01M17.3 14h.01',
  };
  function Icon({ name, size = 16 }) {
    return h('svg', {
      viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
      strokeWidth: name === 'grip' ? 3 : 1.65, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true, focusable: false,
    }, h('path', { d: paths[name] }));
  }
  function Button({ icon, label, children, buttonRef, className = '', ...props }) {
    return h('button', {
      ref: buttonRef, type: 'button', className: `dsh-st-btn ${className}`,
      title: label, 'aria-label': label, ...props,
    }, icon && h(Icon, { name: icon }), children);
  }
  function PaneMessage({ text, retry, busy, t }) {
    return h('div', { className: 'dsh-st-pane-message', role: busy ? 'status' : undefined },
      h('span', null, text), retry && h(Button, { className: 'dsh-st-secondary', onClick: retry }, t('retry')));
  }
  function canSwipe(target, boundary) {
    if (!(target instanceof Element)
      || target.closest('a,button,input,textarea,select,[contenteditable],[role=button],[role=menu],pre,table,.dsh-st-dock,.dsh-st-tabs')) return false;
    for (let node = target; node && node !== boundary; node = node.parentElement) {
      if (node.scrollWidth > node.clientWidth + 3 && /auto|scroll/.test(getComputedStyle(node).overflowX)) return false;
    }
    return true;
  }

  return {
    inject: ['slots', 'layout', 'locale', 'sessions', 'uiWorkspace', 'workspaces'],
    apply(ctx) {
      const embedded = nativeFrameTarget(window);
      if (embedded) { installNativeTilePage(ctx, React, window, embedded); return; }
      const NativeFrame = createNativeFrame(React, Button);
      let store, sizes, bindings;
      ctx.effect(() => {
        store = createOrderStore(() => window.localStorage, window);
        sizes = createSizingStore(() => window.localStorage, window);
        bindings = createSessionBindingStore(() => window.localStorage, window);
        return () => { store.dispose(); sizes.dispose(); bindings.dispose(); };
      }, `${panel}: browser preferences`);
      ctx.effect(() => ctx.locale.register(panel, dictionaries), `${panel}: locales`);
      const label = ctx.locale.bind(panel);
      const useOrder = () => useSyncExternalStore(store.subscribe, store.getSnapshot);
      const useBindings = () => useSyncExternalStore(bindings.subscribe, bindings.getSnapshot);
      function joinSession(sessionId, beforeAdd) {
        // A previous Web Lock holder may have written before this tab received
        // its storage events. Join against current preferences, not stale React.
        store.sync(); bindings.sync(); sizes.sync();
        const anchor = chooseSessionTile(store.getSnapshot().order, bindings.getSnapshot().targets, sessionId,
          () => `tile:${nativeFrameToken()}`);
        beforeAdd?.(anchor);
        bindings.bind(anchor, sessionId);
        store.prepend(anchor);
        return anchor;
      }

      function Toggle({ sessionId, useSessions, t }) {
        const { order } = useOrder();
        const { targets } = useBindings();
        const isSubagent = useSessions(state => state.byId[sessionId]?.origin === 'subagent');
        if (isSubagent) return null;
        const anchor = findSessionTile(order, targets, sessionId);
        const selected = anchor !== undefined;
        return h(React.Fragment, null, h('style', null, headerCss),
          h('button', {
            type: 'button', className: 'dsh-st-toggle', title: t(selected ? 'remove' : 'add'),
            'aria-label': t('toggle'), 'aria-pressed': selected,
            onClick: () => selected ? store.toggle(anchor) : joinSession(sessionId),
          }, h(Icon, { name: selected ? 'tilesSelected' : 'tiles' })));
      }

      function Panel({ useSessions, useWorkspaces, t }) {
        const { order, saveFailed } = useOrder();
        const { targets, saveFailed: bindingFailed } = useBindings();
        const rootOf = id => tileSessionId(targets, id);
        const { sizing, saveFailed: sizingFailed } = useSyncExternalStore(sizes.subscribe, sizes.getSnapshot);
        const ids = useSessions(state => state.ids);
        const byId = useSessions(state => state.byId);
        const sessionPhase = useSessions(state => state.phase);
        const archivedIds = useWorkspaces(state => state.archivedSessionIds);
        const workspaceList = useWorkspaces(state => state.items);
        const workspacePhase = useWorkspaces(state => state.phase);
        const archived = useMemo(() => new Set(archivedIds), [archivedIds]);
        const workspaceOf = useMemo(() => {
          const result = new Map();
          for (const item of workspaceList) for (const id of item.sessionIds) result.set(id, item.title);
          return result;
        }, [workspaceList]);
        const ready = sessionPhase === 'ready' && workspacePhase === 'ready';
        const rowOf = id => Object.hasOwn(byId, id) ? byId[id] : undefined;
        const titleOf = id => rowOf(id)?.displayTitle || t('untitled');
        const detailOf = id => workspaceOf.get(id) || rowOf(id)?.cwd || '';
        const availability = id => sessionAvailability(rowOf(id), archived.has(id), ready);

        const [manage, setManage] = useState(false);
        const [newBusy, setNewBusy] = useState(false);
        const [newError, setNewError] = useState(false);
        const [revealId, setRevealId] = useState(null);
        const [query, setQuery] = useState('');
        const [activeId, setActiveId] = useState(null);
        const [frameSessions, setFrameSessions] = useState(() => Object.create(null));
        const pendingRoots = useRef(new Map());
        const [mobile, setMobile] = useState(() => window.matchMedia(mobileQuery).matches);
        const [viewport, setViewport] = useState({ width: 0, height: 0 });
        const [preview, setPreview] = useState(null);
        const [dragging, setDragging] = useState(null);
        const [dragOver, setDragOver] = useState(null);
        const gridWindowRef = useRef(null);
        const manageRef = useRef(null);
        const newRef = useRef(null);
        const pickerRef = useRef(null);
        const createPending = useRef(false);
        const mounted = useRef(false);
        useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
        const searchRef = useRef(null);
        const drag = useRef(null);
        const touch = useRef(null);
        useEffect(() => {
          const media = window.matchMedia(mobileQuery);
          const update = () => setMobile(media.matches);
          media.addEventListener('change', update);
          update();
          return () => media.removeEventListener('change', update);
        }, []);
        const hasGrid = order.length > 0;
        useEffect(() => {
          const element = gridWindowRef.current;
          if (!element || mobile) return;
          const read = () => {
            const width = Math.max(0, element.clientWidth - 2 * TILE_GAP);
            const height = Math.max(0, element.clientHeight);
            setViewport(previous => width === previous.width && height === previous.height ? previous : { width, height });
          };
          read();
          const observer = new ResizeObserver(read);
          observer.observe(element);
          return () => observer.disconnect();
        }, [hasGrid, mobile]);

        const index = Math.max(0, order.indexOf(activeId));
        const current = order[index];
        useEffect(() => {
          if (activeId !== current) setActiveId(current ?? null);
        }, [activeId, current]);
        function navigate(offset) {
          const target = order[index + offset];
          if (target) setActiveId(target);
        }
        function retainDesktopWidths() {
          const currentSizing = sizes.getSnapshot().sizing;
          if (mobile) return currentSizing; // Never store a mobile projection.
          const measuredWidth = Math.max(0, (gridWindowRef.current?.clientWidth ?? 0) - 2 * TILE_GAP) || viewport.width;
          if (measuredWidth <= 0) return currentSizing;
          const next = retainSessionWidths(currentSizing, store.getSnapshot().order, measuredWidth);
          if (next !== currentSizing) sizes.save(next);
          return next;
        }
        function prepareAddedWidth(id) {
          const saved = retainDesktopWidths();
          if (mobile || Object.hasOwn(saved.paneWidths ?? {}, id)) return;
          sizes.save({ ...saved, paneWidths: { ...saved.paneWidths, [id]: DEFAULT_OVERFLOW_WIDTH } });
        }
        function addSession(sessionId) {
          const anchor = joinSession(sessionId, prepareAddedWidth);
          setActiveId(anchor); setRevealId(anchor);
        }
        function frameNavigated(anchor, next, rootHint) {
          if (!store.getSnapshot().order.includes(anchor)) return;
          setFrameSessions(old => old[anchor] === next ? old : Object.assign(Object.create(null), old, { [anchor]: next }));
          const liveRows = ctx.sessions.list.getSnapshot().byId;
          if (canRememberRootSession(next, rootHint, liveRows)) {
            pendingRoots.current.delete(anchor);
            bindings.bind(anchor, next);
          } else if (rootHint !== false && !Object.hasOwn(liveRows, next)) {
            pendingRoots.current.set(anchor, next);
          } else pendingRoots.current.delete(anchor);
        }
        useEffect(() => {
          for (const [anchor, next] of pendingRoots.current) {
            if (!order.includes(anchor)) { pendingRoots.current.delete(anchor); continue; }
            if (!Object.hasOwn(byId, next)) continue;
            pendingRoots.current.delete(anchor);
            if (canRememberRootSession(next, undefined, byId)) bindings.bind(anchor, next);
          }
        }, [byId, order]);
        function toggle(id) {
          const present = store.getSnapshot().order.includes(id);
          if (present) {
            retainDesktopWidths();
            if (id === current) setActiveId(order[index + 1] ?? order[index - 1] ?? null);
            store.toggle(id);
          } else {
            addSession(id);
          }
        }
        function showManage() {
          if (createPending.current) return;
          setQuery(''); setManage(true);
        }
        function finishManage() { setManage(false); }
        useEffect(() => {
          const dialog = pickerRef.current;
          if (!dialog) return;
          if (manage) {
            dialog.showModal();
            searchRef.current?.focus({ preventScroll: true });
          } else if (dialog.open) {
            dialog.close();
            manageRef.current?.focus({ preventScroll: true });
          }
          return () => { if (dialog.open) dialog.close(); };
        }, [manage]);
        function occupiedSessions() {
          const occupied = new Set();
          const include = (order, targets) => {
            for (const anchor of order) {
              occupied.add(anchor); occupied.add(tileSessionId(targets, anchor));
              if (typeof frameSessions[anchor] === 'string') occupied.add(frameSessions[anchor]);
            }
          };
          include(store.getSnapshot().order, bindings.getSnapshot().targets);
          // Web Locks span tabs; storage events may not have reached this tab's
          // React stores yet when the previous holder releases the lock.
          try { include(parseOrder(window.localStorage.getItem(STORAGE_KEY)),
            parseSessionBindings(window.localStorage.getItem(SESSION_BINDINGS_KEY))); } catch { /* Memory state still protects this tab. */ }
          for (const target of pendingRoots.current.values()) occupied.add(target);
          return occupied;
        }
        async function createSession() {
          if (createPending.current) return;
          createPending.current = true;
          setNewBusy(true); setNewError(false);
          try {
            const createAndJoin = async () => {
              if (!mounted.current) return;
              const id = await createDefaultTileSession(ctx, occupiedSessions);
              if (mounted.current) addSession(id);
            };
            if (typeof window.navigator.locks?.request === 'function') {
              await window.navigator.locks.request('dsh-session-tiles:new-default-session', createAndJoin);
            } else await createAndJoin();
          } catch (error) {
            console.warn('[dsh-tile-layout] Session creation failed', error);
            if (mounted.current) setNewError(true);
          } finally {
            createPending.current = false;
            if (mounted.current) setNewBusy(false);
          }
        }
        useEffect(() => {
          if (!revealId || mobile || manage) return;
          const element = Array.from(gridWindowRef.current?.querySelectorAll('[data-tile-session]') ?? [])
            .find(node => node.dataset.tileSession === revealId);
          if (element) {
            if (order[0] === revealId) gridWindowRef.current.scrollLeft = 0;
            else element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            setRevealId(null);
          }
        }, [revealId, mobile, manage, order]);
        function endDrag() {
          drag.current = null;
          setDragging(null);
          setDragOver(null);
        }
        function onTouchStart(event) {
          touch.current = null;
          if (!mobile || event.touches.length !== 1 || !canSwipe(event.target, event.currentTarget)) return;
          const point = event.touches[0];
          touch.current = { id: point.identifier, x: point.clientX, y: point.clientY };
        }
        function onTouchEnd(event) {
          const start = touch.current;
          touch.current = null;
          if (!start || event.touches.length) return;
          const point = Array.from(event.changedTouches).find(value => value.identifier === start.id);
          const direction = point && swipeDirection(point.clientX - start.x, point.clientY - start.y);
          if (direction) navigate(direction);
        }
        const visible = mobile ? (current ? [current] : []) : order;
        // Moving an iframe's DOM subtree reloads its browsing context. Keep
        // desktop DOM order stable; only gridColumn follows the user's order.
        const rendered = mobile ? visible : visible.slice().sort();
        const search = query.trim().toLocaleLowerCase();
        const choices = manage ? sessionPickerChoices(order, targets, ids, byId, archived, ready)
          .filter(choice => !search || `${titleOf(choice.sessionId)} ${detailOf(choice.sessionId)}`.toLocaleLowerCase().includes(search)) : [];
        const columns = mobile ? 1 : Math.max(visible.length, 1);
        const measured = !mobile && viewport.width > 0;
        const stableSizing = useMemo(() => measured ? retainSessionWidths(sizing, order, viewport.width) : sizing,
          [measured, sizing, order, viewport.width]);
        const originalGeometry = sessionStrip(stableSizing, visible, viewport.width);
        const { widths } = sessionStrip(preview ?? stableSizing, visible, viewport.width);
        useEffect(() => {
          if (measured && !preview && order.length > 0 && stableSizing !== sizing) sizes.save(stableSizing);
        }, [measured, preview, order.length, stableSizing, sizing]);
        const tracks = measured ? {
          gridTemplateColumns: `${tiledTracks(widths.map(value => `${value}px`))} ${TILE_GAP}px`,
          gridTemplateRows: 'minmax(0, 1fr)',
          height: viewport.height,
        } : undefined;
        function bindResize(candidate) {
          return {
            begin() {
              return {
                update(delta, commit) {
                  const next = candidate(delta);
                  if (commit) { setPreview(null); if (next) sizes.save(next); }
                  else setPreview(next ?? null);
                },
                cancel: () => setPreview(null),
              };
            },
            nudge(delta) { const next = candidate(delta); if (next) sizes.save(next); },
          };
        }
        function columnGrip(boundary) {
          const id = visible[boundary];
          const candidate = delta => {
            const next = resizeSessionWidth(stableSizing, order, viewport.width, id, delta);
            return next === stableSizing ? null : next;
          };
          return h(Splitter, {
            key: `x:${id}`, axis: 'x', label: t('resizeWidth'),
            value: widths[boundary], min: MIN_TILE_WIDTH, max: Math.max(widths[boundary], 10000),
            style: { gridColumn: 2 * boundary + 2, gridRow: '1' },
            ...bindResize(candidate),
            reset: () => { const next = candidate(DEFAULT_OVERFLOW_WIDTH - widths[boundary]); if (next) sizes.save(next); },
          });
        }

        return h('section', {
          className: 'dsh-st', 'data-mobile': mobile, 'data-reordering': dragging ? true : undefined, 'aria-label': t('title'),

        },
          h('style', null, css),
          h('div', { className: 'dsh-st-workspace' },
            h('nav', { className: 'dsh-st-tools', 'aria-label': t('title') },
              h(Button, {
                buttonRef: newRef, icon: 'plus', label: t(newBusy ? 'creatingSession' : 'newSession'),
                disabled: newBusy || !ready, 'aria-busy': newBusy,
                onClick: createSession,
              }),
              h(Button, {
                buttonRef: manageRef, icon: 'list', label: t('manage'), disabled: newBusy,
                'aria-expanded': manage, 'aria-controls': 'dsh-st-session-picker',
                onClick: manage ? finishManage : showManage,
              })),
            h('div', { className: 'dsh-st-stage' },
          (saveFailed || sizingFailed || bindingFailed) && h('div', { className: 'dsh-st-warning', role: 'status' }, t('saveError')),
          newError && h('p', { role: 'alert', className: 'dsh-st-warning' }, t('createFailed')),
          h('dialog', {
            ref: pickerRef, id: 'dsh-st-session-picker', className: 'dsh-st-session-dialog',
            'aria-label': t('manage'),
            onCancel: event => { event.preventDefault(); finishManage(); },
            onClick: event => {
              if (event.target !== event.currentTarget) return;
              const box = event.currentTarget.getBoundingClientRect();
              if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) finishManage();
            },
          }, h('div', { className: 'dsh-st-picker' },
            h('div', { className: 'dsh-st-picker-head' }, h('h2', null, t('manage')),
              h(Button, { className: 'dsh-st-secondary', onClick: finishManage }, t('done'))),
            h('p', { className: 'dsh-st-muted' }, t('manageHint')),
            h('input', {
              className: 'dsh-st-search', type: 'search', ref: searchRef, value: query,
              'aria-label': t('search'), placeholder: t('search'), onChange: event => setQuery(event.currentTarget.value),
            }),
            choices.length === 0
              ? h('p', { className: 'dsh-st-muted', role: 'status' }, t(search ? 'noResults' : ready ? 'noSessions' : 'loading'))
              : h('ul', { className: 'dsh-st-list' }, choices.map(({ anchor, sessionId }) => {
                const position = anchor === undefined ? -1 : order.indexOf(anchor);
                 const title = titleOf(sessionId);
                const unavailable = availability(sessionId);
                const detail = unavailable ? t(unavailable) : detailOf(sessionId);
                return h('li', { key: anchor === undefined ? `session:${sessionId}` : `tile:${anchor}`, className: 'dsh-st-row' },
                  h('label', { className: 'dsh-st-choice' },
                    h('input', { type: 'checkbox', checked: position >= 0, onChange: () => anchor === undefined ? addSession(sessionId) : toggle(anchor) }),
                    h('span', { className: 'dsh-st-choice-text' }, h('span', { title }, title),
                      detail && h('small', { title: detail }, detail))),
                  position >= 0 && h('div', { className: 'dsh-st-row-actions' },
                    h(Button, { icon: 'up', label: `${t('earlier')} · ${title}`, disabled: position === 0,
                      onClick: () => store.step(anchor, -1) }),
                    h(Button, { icon: 'down', label: `${t('later')} · ${title}`, disabled: position === order.length - 1,
                      onClick: () => store.step(anchor, 1) })));
              })))),
          order.length === 0 && h('div', { className: 'dsh-st-empty' },
            h(Icon, { name: 'tiles', size: 32 }), h('h2', null, t('empty')),
            h('p', { className: 'dsh-st-muted' }, t('emptyHint')),
            h(Button, { icon: 'list', className: 'dsh-st-secondary', onClick: showManage }, t('manage'))),
          hasGrid && h('div', {
            className: 'dsh-st-grid-window', ref: gridWindowRef,
            tabIndex: originalGeometry.scrolls && !mobile ? 0 : undefined,
            'aria-label': originalGeometry.scrolls && !mobile ? t('scrollStrip') : undefined,
            role: originalGeometry.scrolls && !mobile ? 'region' : undefined,
          },
            h('div', { className: 'dsh-st-grid', style: tracks },
            rendered.map(id => {
              const position = visible.indexOf(id);
               const sessionId = rootOf(id);
               const displayedId = frameSessions[id] ?? sessionId;
               const title = titleOf(displayedId);
              const live = typeof frameSessions[id] === 'string';
               const notReady = live ? null : availability(sessionId);
              const locked = !live && (notReady === 'loading' || (notReady === null && workspacePhase !== 'ready'));
              return h('article', {
                key: id, className: 'dsh-st-pane', 'data-tile-session': id, 'data-dragging': dragging === id || undefined,
                'data-drop': dragOver === id || undefined, 'aria-label': title,
                style: measured ? { gridColumn: 2 * (position % columns) + 1, gridRow: 2 * Math.floor(position / columns) + 1 } : undefined,
                onTouchStart, onTouchEnd, onTouchCancel: () => { touch.current = null; },
                onDragOver: event => {
                  if (!drag.current || drag.current === id) { setDragOver(null); return; }
                  event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOver(id);
                },
                onDrop: event => {
                  if (!drag.current) return;
                  event.preventDefault(); store.move(drag.current, id); endDrag();
                },
              },
              h('div', { className: 'dsh-st-pane-head' },
                !mobile && order.length > 1 && h(Button, {
                  className: 'dsh-st-grip', icon: 'grip', label: t('drag'), draggable: true,
                  onDragStart: event => {
                    drag.current = id; setDragging(id);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('application/x-dsh-session-tile', id);
                  },
                  onDragEnd: endDrag,
                  onKeyDown: event => {
                    const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
                    if (offset === undefined) return;
                    event.preventDefault(); event.stopPropagation(); store.step(id, offset);
                  },
                }),
                h('h2', { title }, title),
                mobile && order.length > 1 && h('span', { className: 'dsh-st-mobile-nav' },
                  h(Button, { icon: 'prev', label: t('prev'), disabled: index === 0, onClick: () => navigate(-1) }),
                  h(Button, { icon: 'next', label: t('next'), disabled: index >= order.length - 1, onClick: () => navigate(1) })),
                (notReady === null || notReady === 'migration') && h(Button, {
                  icon: 'open', label: t('open'), onClick: () => ctx.uiWorkspace.openSession(displayedId),
                }),
                h(Button, { icon: 'close', label: t('remove'), onClick: () => toggle(id) })),
              h('div', { className: 'dsh-st-pane-body' },
                locked || notReady
                  ? h(PaneMessage, { text: t(locked ? 'loading' : notReady), busy: locked, t })
                  : h(NativeFrame, {
                    id, sessionId, title, t, onSwipe: direction => { if (mobile) navigate(direction); },
                    onNavigate: (next, rootHint) => frameNavigated(id, next, rootHint),
                  })));
            }),
            measured && Array.from({ length: columns }, (_, index) => columnGrip(index)))))));

      }

      ctx.slots.inject('main', function* () {
        yield ctx.slots.register({ name: 'main', key: panel, locale: panel }, Panel);
        // Restore only after main exists. Reverse disposal unsubscribes before
        // removing the entry, so HMR cannot clear the saved active-page flag.
        yield rememberTilePanel(ctx.layout, () => window.sessionStorage, panel);
      });
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: panel, order: 5, label: () => label('title'),
      }, ({ size }) => h(Icon, { name: 'tiles', size })));
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities', id: panel, order: 2, locale: panel,
      }, Toggle));
    },
  };
}
