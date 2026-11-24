import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { createServer } from '../src/server.js';
import { AiError } from '../src/classifier.js';

async function start({ testKey } = {}) {
  const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'sorter-')));
  const bot = {
    state: { connection: 'connected', qr: null, me: { name: 'Bot', number: '91' }, problem: null, aiProblem: 'old problem', groups: new Map([['B@g.us', { id: 'B@g.us', name: 'Beta', adminIds: new Set(['x']) }], ['A@g.us', { id: 'A@g.us', name: 'Alpha', adminIds: new Set() }]]) },
    unlinked: 0,
    async unlink() { this.unlinked += 1; },
    async refreshGroups() {},
  };
  const port = 41000 + Math.floor(Math.random() * 2000);
  const web = createServer({ store, bot, port, testKey: testKey || (async () => true) });
  await web.listen();
  const base = `http://127.0.0.1:${port}`;
  const post = (p, body, headers = { 'content-type': 'application/json', 'x-group-sorter': '1' }) =>
    fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) });
  return { store, bot, web, base, post, port };
}

test('the page and the state load, and the key never leaves the computer', async () => {
  const t = await start();
  try {
    t.store.update({ apiKey: 'sk-ant-secret-1234' });
    const page = await fetch(t.base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Group Sorter<\/title>/);
    const raw = await (await fetch(t.base + '/api/state')).text();
    assert.ok(!raw.includes('sk-ant-secret'), 'the saved key is not sent to the page');
    const state = JSON.parse(raw);
    assert.equal(state.settings.hasKey, true);
    assert.equal(state.settings.keyEnding, '1234');
    assert.deepEqual(state.groups.map((g) => g.name), ['Alpha', 'Beta']);
    assert.equal(state.groups[0].adminIds, undefined);
  } finally { await t.web.close(); }
});

test('settings save and survive a restart; the key cannot be changed through settings', async () => {
  const t = await start();
  try {
    t.store.update({ apiKey: 'sk-real' });
    const res = await t.post('/api/settings', {
      mode: 'move', threshold: 0.9, apiKey: 'sk-hijack',
      topics: [{ id: 'jobs', name: 'Jobs', description: 'd', groupId: 'A@g.us' }], watchGroupIds: ['B@g.us'],
    });
    const out = await res.json();
    assert.equal(out.ok, true);
    assert.equal(out.state.settings.mode, 'move');
    assert.equal(out.state.watching, 2);
    assert.equal(t.store.config.apiKey, 'sk-real');
    const reloaded = createStore(t.store.dataDir);
    assert.equal(reloaded.config.mode, 'move');
    assert.equal(reloaded.config.topics[0].groupId, 'A@g.us');
  } finally { await t.web.close(); }
});

test('a key is saved only if it works', async () => {
  const bad = await start({ testKey: async () => { throw new AiError('The AI key was rejected. Check that you copied the whole key.'); } });
  try {
    const out = await (await bad.post('/api/key', { apiKey: 'sk-wrong' })).json();
    assert.equal(out.ok, false);
    assert.match(out.error, /rejected/);
    assert.equal(bad.store.config.apiKey, '');
  } finally { await bad.web.close(); }

  const good = await start();
  try {
    const out = await (await good.post('/api/key', { apiKey: '  sk-good-9999  ' })).json();
    assert.equal(out.ok, true);
    assert.equal(good.store.config.apiKey, 'sk-good-9999');
    assert.equal(good.bot.state.aiProblem, null);
  } finally { await good.web.close(); }
});

test('pause and unlink work', async () => {
  const t = await start();
  try {
    assert.equal((await (await t.post('/api/pause', { paused: true })).json()).state.settings.paused, true);
    await t.post('/api/unlink', {});
    assert.equal(t.bot.unlinked, 1);
  } finally { await t.web.close(); }
});

test('other websites cannot change the bot: wrong host or missing header is refused', async () => {
  const t = await start();
  try {
    const noHeader = await t.post('/api/pause', { paused: true }, { 'content-type': 'application/json' });
    assert.equal(noHeader.status, 403);
    const formPost = await t.post('/api/pause', { paused: true }, { 'content-type': 'text/plain', 'x-group-sorter': '1' });
    assert.equal(formPost.status, 403);
    assert.equal(t.store.config.paused, false);

    // A page on another site that points its own name at this computer is refused too.
    const http = await import('node:http');
    const status = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: t.port, path: '/api/state', headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode));
      req.end();
    });
    assert.equal(status, 403);
  } finally { await t.web.close(); }
});
