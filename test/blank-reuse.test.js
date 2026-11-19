import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultTileSession, reusableTileBlank } from '../src/state.js';

function fixture({ legacy = false, rows = {} } = {}) {
  const workspace = { workspaceId: 'default', path: '/default', sessionIds: Object.keys(rows) };
  const workspaces = { phase: 'ready', items: legacy ? [] : [workspace], archivedSessionIds: [] };
  const sessions = { phase: 'ready', ids: Object.keys(rows), byId: rows };
  const occupied = new Set(), live = new Map(), requests = [], refreshed = [];
  let minted = 0;
  const ctx = {
    workspaces: { initializeDefault: async () => legacy ? undefined : workspace, list: { getSnapshot: () => workspaces } },
    sessions: {
      list: { getSnapshot: () => sessions }, binding: id => live.get(id),
      refreshProjections: async id => { refreshed.push(id); },
      create: async input => {
        requests.push(input);
        if (input.sessionId) return input.sessionId;
        const id = `fresh-${++minted}`;
        sessions.ids.unshift(id);
        sessions.byId[id] = { blank: true, running: false, cwd: '/default', retainedBy: {} };
        if (!legacy) workspace.sessionIds.push(id);
        return id;
      },
    },
  };
  const pick = preset => reusableTileBlank(legacy ? undefined : workspace, workspaces, sessions, occupied, preset, id => live.get(id));
  return { ctx, workspace, workspaces, sessions, occupied, live, requests, refreshed, pick };
}
const blank = extra => ({ blank: true, running: false, cwd: '/default', retainedBy: {}, ...extra });

test('repeated new → unused close → new reuses one blank rather than accumulating records', async () => {
  const f = fixture(), seen = [];
  for (let n = 0; n < 8; n++) {
    const id = await createDefaultTileSession(f.ctx, () => f.occupied);
    seen.push(id); f.occupied.add(id); f.occupied.delete(id);
  }
  assert.equal(new Set(seen).size, 1);
  assert.deepEqual(f.sessions.ids, ['fresh-1']);
  assert.deepEqual(f.requests[0], { workspaceId: 'default' });
  assert.ok(f.requests.slice(1).every(request => request.sessionId === 'fresh-1'));
});

test('simultaneous visible cards keep separate IDs and a closed blank becomes reusable', async () => {
  const f = fixture();
  const first = await createDefaultTileSession(f.ctx, () => f.occupied); f.occupied.add(first);
  const second = await createDefaultTileSession(f.ctx, () => f.occupied); f.occupied.add(second);
  assert.notEqual(first, second);
  f.occupied.delete(first);
  assert.equal(await createDefaultTileSession(f.ctx, () => f.occupied), first);
  assert.deepEqual(f.requests[1], { workspaceId: 'default' });
  assert.equal(f.sessions.ids.length, 2);
});

test('a previously reused blank is never reused after it begins working', async () => {
  const f = fixture();
  const first = await createDefaultTileSession(f.ctx);
  f.sessions.byId[first].blank = false;
  const second = await createDefaultTileSession(f.ctx);
  assert.notEqual(first, second);
  assert.equal(f.requests[1].sessionId, undefined);
});

test('only known unused blank root sessions in the correct workspace can be candidates', () => {
  for (const extra of [{ blank: false }, { blank: undefined }, { running: true }, { origin: 'subagent' },
    { formatStatus: 'migration-required' }, { retainedBy: { uiMain: 1 } }, { cwd: '/different' }]) {
    const f = fixture({ rows: { candidate: blank(extra) } });
    assert.equal(f.pick(), undefined, JSON.stringify(extra));
  }
  const f = fixture({ rows: { candidate: blank() } });
  f.workspace.sessionIds = [];
  assert.equal(f.pick(), undefined);
  f.workspace.sessionIds = ['candidate']; f.workspaces.archivedSessionIds = ['candidate'];
  assert.equal(f.pick(), undefined);
  f.workspaces.archivedSessionIds = []; f.occupied.add('candidate');
  assert.equal(f.pick(), undefined);
});

test('local accepted, pending, or running submissions override a stale blank list row', () => {
  for (const state of [{ blank: false }, { running: true }, { promptAttempted: true },
    { awaitingFirstTurn: true }, { pendingSubmissions: [{ requestId: 'pending' }] }]) {
    const f = fixture({ rows: { candidate: blank() } });
    f.live.set('candidate', { session: { getSnapshot: () => ({ blank: true, ...state }) } });
    assert.equal(f.pick(), undefined, JSON.stringify(state));
  }
});

test('explicit preset filtering follows native reuse while an unlisted preset can be initialized', async () => {
  const f = fixture({ rows: { wrong: blank({ projectionValues: { agentPreset: 'other' } }),
    matching: blank({ projectionValues: { agentPreset: 'wanted' } }) } });
  assert.equal(f.pick('wanted'), 'matching');
  assert.equal(await createDefaultTileSession(f.ctx, () => f.occupied, { agentPreset: 'wanted' }), 'matching');
  assert.deepEqual(f.requests[0], { workspaceId: 'default', sessionId: 'matching', agentPreset: 'wanted' });
  f.sessions.byId.matching.projectionValues = {};
  assert.equal(f.pick('wanted'), 'matching');
});

test('legacy defaults reuse only ungrouped candidates and never pass a guessed cwd or workspace', async () => {
  const f = fixture({ legacy: true, rows: { grouped: blank(), ungrouped: blank() } });
  f.workspaces.items = [{ workspaceId: 'unrelated', path: '/different', sessionIds: ['grouped'] }];
  assert.equal(await createDefaultTileSession(f.ctx), 'ungrouped');
  assert.deepEqual(f.requests, [{ sessionId: 'ungrouped' }]);
});

test('Host refusal to reuse a now-working candidate uses the actual new ID and refreshes the old hint', async () => {
  const f = fixture({ rows: { candidate: blank() } });
  f.ctx.sessions.create = async input => { f.requests.push(input); return 'authoritative-new'; };
  assert.equal(await createDefaultTileSession(f.ctx), 'authoritative-new');
  assert.deepEqual(f.refreshed, ['candidate']);
  assert.equal(f.requests.length, 1);
});

test('a legacy cwd conflict drops the reuse hint without overriding Host default directory', async () => {
  const f = fixture({ legacy: true, rows: { stale: blank({ cwd: '/old-host-default' }) } });
  f.ctx.sessions.create = async input => {
    f.requests.push(input);
    if (input.sessionId) throw Object.assign(new Error('cwd changed'), { rpcError: { code: 'session/conflict', details: { requestedCwd: '/current-host-default', existingCwd: '/old-host-default' } } });
    return 'new-host-default';
  };
  assert.equal(await createDefaultTileSession(f.ctx), 'new-host-default');
  assert.deepEqual(f.requests, [{ sessionId: 'stale' }, {}]);
  assert.deepEqual(f.refreshed, ['stale']);
});

test('unrelated creation failures are not hidden by an automatic fresh retry', async () => {
  const f = fixture({ rows: { candidate: blank() } });
  f.ctx.sessions.create = async input => {
    f.requests.push(input);
    throw Object.assign(new Error('preset refused'), { rpcError: { code: 'agent-preset/invalid' } });
  };
  await assert.rejects(createDefaultTileSession(f.ctx), /preset refused/);
  assert.equal(f.requests.length, 1);
});

test('a candidate claimed during the RPC is replaced by a fresh session, never shared with that card', async () => {
  const f = fixture({ rows: { candidate: blank() } });
  const normalCreate = f.ctx.sessions.create;
  f.ctx.sessions.create = async input => {
    if (input.sessionId) f.occupied.add(input.sessionId);
    return normalCreate(input);
  };
  assert.equal(await createDefaultTileSession(f.ctx, () => f.occupied), 'fresh-1');
  assert.deepEqual(f.requests, [{ workspaceId: 'default', sessionId: 'candidate' }, { workspaceId: 'default' }]);
  assert.equal(f.occupied.has('candidate'), true);
});

test('pending catalogues do not supply unsafe reuse hints', () => {
  const f = fixture({ rows: { candidate: blank() } });
  f.sessions.phase = 'pending'; assert.equal(f.pick(), undefined);
  f.sessions.phase = 'ready'; f.workspaces.phase = 'pending'; assert.equal(f.pick(), undefined);
});


test('cwd conflicts without an existingCwd still fall back to the authoritative Host default', async () => {
  const f = fixture({ legacy: true, rows: { candidate: blank() } });
  f.ctx.sessions.create = async input => {
    f.requests.push(input);
    if (input.sessionId) throw Object.assign(new Error('missing prior cwd'), {
      rpcError: { code: 'session/conflict', details: { requestedCwd: '/default' } },
    });
    return 'fresh-default';
  };
  assert.equal(await createDefaultTileSession(f.ctx), 'fresh-default');
  assert.deepEqual(f.requests, [{ sessionId: 'candidate' }, {}]);
});

test('non-cwd session conflicts are not swallowed or retried', async () => {
  const f = fixture({ rows: { candidate: blank() } });
  f.ctx.sessions.create = async input => {
    f.requests.push(input);
    throw Object.assign(new Error('other conflict'), { rpcError: { code: 'session/conflict', details: {} } });
  };
  await assert.rejects(createDefaultTileSession(f.ctx), /other conflict/);
  assert.equal(f.requests.length, 1);
});
