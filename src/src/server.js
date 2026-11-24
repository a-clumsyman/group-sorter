// Serves the setup page on this computer only (http://localhost:3210).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { ROOT } from './store.js';
import { testKey as realTestKey, AiError } from './classifier.js';
import { watchedGroupIds } from './router.js';

const PAGE = path.join(ROOT, 'public', 'index.html');
const BODY_LIMIT = 200_000;

function publicSettings(config) {
  const { apiKey, ...rest } = config;
  return { ...rest, hasKey: Boolean(apiKey), keyEnding: apiKey ? apiKey.slice(-4) : '' };
}

function snapshot(store, bot) {
  const config = store.config;
  const groups = [...bot.state.groups.values()]
    .map(({ adminIds, ...g }) => g)
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    connection: bot.state.connection,
    qr: bot.state.qr,
    me: bot.state.me,
    problem: bot.state.problem,
    aiProblem: bot.state.aiProblem,
    groups,
    watching: watchedGroupIds(config).size,
    settings: publicSettings(config),
    activity: store.activity.slice(-60).reverse(),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

export function createServer({ store, bot, port = 3210, testKey = realTestKey }) {
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);

  const send = (res, status, data) => {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    try {
      // Only this computer's own browser may talk to the bot.
      if (!allowedHosts.has(req.headers.host || '')) return send(res, 403, { error: 'Not allowed' });
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(fs.readFileSync(PAGE));
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, snapshot(store, bot));

      if (req.method !== 'POST') return send(res, 404, { error: 'Not found' });
      // Other websites cannot send this header, so they cannot change the bot's settings.
      if (req.headers['x-group-sorter'] !== '1' || !(req.headers['content-type'] || '').includes('application/json')) {
        return send(res, 403, { error: 'Not allowed' });
      }
      const body = await readBody(req);

      if (url.pathname === '/api/settings') {
        const { apiKey, hasKey, keyEnding, ...patch } = body; // the key is saved through /api/key only
        store.update(patch);
        return send(res, 200, { ok: true, state: snapshot(store, bot) });
      }

      if (url.pathname === '/api/key') {
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
        if (!apiKey) return send(res, 200, { ok: false, error: 'Paste the key first.' });
        try {
          await testKey({ apiKey, model: store.config.model });
        } catch (err) {
          const error = err instanceof AiError ? err.message : 'Could not check the key. Try again.';
          return send(res, 200, { ok: false, error });
        }
        store.update({ apiKey });
        bot.state.aiProblem = null;
        return send(res, 200, { ok: true, state: snapshot(store, bot) });
      }

      if (url.pathname === '/api/pause') {
        store.update({ paused: body.paused === true });
        return send(res, 200, { ok: true, state: snapshot(store, bot) });
      }

      if (url.pathname === '/api/unlink') {
        await bot.unlink();
        return send(res, 200, { ok: true, state: snapshot(store, bot) });
      }

      if (url.pathname === '/api/refresh-groups') {
        await bot.refreshGroups().catch(() => {});
        return send(res, 200, { ok: true, state: snapshot(store, bot) });
      }

      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      return send(res, 400, { error: 'That request could not be read.' });
    }
  });

  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(port));
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
