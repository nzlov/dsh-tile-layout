import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { STORAGE_KEY, SESSION_BINDINGS_KEY, PANEL_VIEW_KEY } from '../src/state.js';
import { LAYOUT_KEY } from '../src/layout.js';
import { TILE_FRAME_CHANNEL, nativeFrameTarget, nativeFrameUrl } from '../src/native-frame.js';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('runtime storage and message identities use the package namespace', () => {
  assert.equal(STORAGE_KEY, `${manifest.name}:order:v1`);
  assert.equal(SESSION_BINDINGS_KEY, `${manifest.name}:session-bindings:v1`);
  assert.equal(PANEL_VIEW_KEY, `${manifest.name}:active-panel:v1`);
  assert.equal(LAYOUT_KEY, `${manifest.name}:sizing:v1`);
  assert.equal(TILE_FRAME_CHANNEL, `${manifest.name}:native:v1`);
});

test('iframe rendering and startup agree on the named marker while both icon formats ship', async () => {
  const source = await readFile(new URL('../src/native-frame.js', import.meta.url), 'utf8');
  assert.ok(source.includes(`'data-${manifest.name}': launch.current.sessionId`));
  const frame = { dataset: { dshTileLayout: 'session', dshTileToken: 'token' } };
  const win = { parent: {}, frameElement: frame, location: { href: nativeFrameUrl('https://gui.example.test/', 'session', 'token') } };
  assert.deepEqual(nativeFrameTarget(win), { sessionId: 'session', token: 'token' });
  assert.equal(manifest.exports['./icon'], './icon.svg');
  assert.ok(manifest.files.includes('icon.svg') && manifest.files.includes('icon.png'));
  const png = await readFile(new URL('../icon.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
