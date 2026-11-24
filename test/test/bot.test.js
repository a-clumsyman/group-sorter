import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createStore } from '../src/store.js';
import { createBot } from '../src/bot.js';
import { AiError } from '../src/classifier.js';

const MAIN = 'MAIN@g.us';
const JOBS = 'JOBS@g.us';
const EVENTS = 'EVENTS@g.us';
const JOB_TEXT = 'We are hiring an ML intern in Vizag. Stipend 20k. Apply at example.com/jobs';

let counter = 0;
const nowSeconds = () => Math.floor(Date.now() / 1000);

function message(content, { group = MAIN, from = '111@s.whatsapp.net', name = 'Ravi', ageSec = 5, fromMe = false, id } = {}) {
  return {
    key: { remoteJid: group, id: id || `MSG${++counter}`, participant: from, fromMe },
    pushName: name,
    messageTimestamp: nowSeconds() - ageSec,
    message: content,
  };
}
const text = (body, opts) => message({ conversation: body }, opts);

function setup({ settings = {}, verdict = { labels: ['jobs'], confidence: 0.95, reason: 'hiring' }, sockOverrides = {}, groupOverrides = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorter-'));
  const store = createStore(dir);
  store.update({
    apiKey: 'sk-test',
    mode: 'nudge',
    topics: [
      { id: 'jobs', name: 'Jobs', description: 'x', groupId: JOBS },
      { id: 'events', name: 'Events', description: 'x', groupId: EVENTS },
    ],
    watchGroupIds: [MAIN],
    ...settings,
  });

  const sent = [];
  const sock = {
    user: { id: '999:3@s.whatsapp.net', lid: '555:3@lid', name: 'Sorter' },
    async sendMessage(jid, content, options) {
      sent.push({ jid, content, options });
      return { key: { remoteJid: jid, id: `SENT${sent.length}`, fromMe: true }, message: content };
    },
    ...sockOverrides,
  };
  const calls = [];
  const bot = createBot({
    store,
    deps: {
      classify: async (input) => {
        calls.push(input);
        if (verdict instanceof Error) throw verdict;
        return verdict;
      },
      downloadImage: async () => Buffer.from('jpegbytes'),
      sleep: async () => {},
      log: () => {},
    },
  });
  const group = (id, name, extra = {}) => [id, { id, name, community: 'Example Community', adminsOnly: false, botAdmin: true, adminIds: new Set(['900@s.whatsapp.net', '901@lid']), ...extra }];
  bot._attach(sock, new Map([
    group(MAIN, 'Example Community', groupOverrides[MAIN]),
    group(JOBS, 'Example Community Jobs', groupOverrides[JOBS]),
    group(EVENTS, 'Example Community Events', groupOverrides[EVENTS]),
  ]));
  return { bot, store, sent, calls, sock };
}

test('reminder mode: replies to a job post in the main group', async () => {
  const { bot, sent, store } = setup();
  const msg = text(JOB_TEXT);
  await bot.handle(msg);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, MAIN);
  assert.equal(sent[0].options.quoted, msg, 'the reminder quotes the original post');
  assert.match(sent[0].content.text, /post about jobs/);
  assert.match(sent[0].content.text, /\*Example Community Jobs\*/);
  const last = store.activity.at(-1);
  assert.equal(last.outcome, 'reminded');
  assert.equal(last.to, 'Example Community Jobs');
});

test('move mode, text post: reposts with credit, removes the original, leaves a note', async () => {
  const { bot, sent, store } = setup({ settings: { mode: 'move' } });
  const msg = text(JOB_TEXT);
  await bot.handle(msg);
  assert.equal(sent.length, 3);
  assert.equal(sent[0].jid, JOBS);
  assert.equal(sent[0].content.text, `Shared by Ravi (moved here from Example Community)\n\n${JOB_TEXT}`);
  assert.equal(sent[1].jid, MAIN);
  assert.deepEqual(sent[1].content, { delete: msg.key });
  assert.equal(sent[2].jid, MAIN);
  assert.match(sent[2].content.text, /Ravi's post has been moved to \*Example Community Jobs\*/);
  assert.equal(store.activity.at(-1).outcome, 'moved');
});

test('move mode, poster with caption: re-sends the image with credit in the caption', async () => {
  const { bot, sent, calls } = setup({ settings: { mode: 'move' }, verdict: { labels: ['events'], confidence: 0.9, reason: 'meetup' } });
  const thumb = Buffer.from('thumb');
  const msg = message({ imageMessage: { caption: 'Join us Saturday', mimetype: 'image/jpeg', jpegThumbnail: thumb, width: 800, height: 1000 } });
  await bot.handle(msg);
  assert.equal(calls[0].image.data.toString(), 'jpegbytes', 'the poster itself is shown to the AI');
  assert.equal(sent[0].jid, EVENTS);
  assert.equal(sent[0].content.image.toString(), 'jpegbytes');
  assert.equal(sent[0].content.caption, 'Shared by Ravi (moved here from Example Community)\n\nJoin us Saturday');
  assert.equal(sent[0].content.jpegThumbnail, thumb);
  assert.deepEqual(sent[1].content, { delete: msg.key });
});

test('an image with no caption is still checked', async () => {
  const { bot, calls, sent } = setup({ verdict: { labels: ['events'], confidence: 0.9, reason: 'poster' } });
  await bot.handle(message({ imageMessage: { mimetype: 'image/jpeg' } }));
  assert.equal(calls.length, 1);
  assert.equal(sent.length, 1);
});

test('move mode, video: forwards it and credits the sender', async () => {
  const { bot, sent } = setup({ settings: { mode: 'move' } });
  const msg = message({ videoMessage: { caption: 'Hiring video: we need two data engineers, apply now' } });
  await bot.handle(msg);
  assert.deepEqual(sent[0].content, { forward: msg });
  assert.equal(sent[0].jid, JOBS);
  assert.equal(sent[1].content.text, 'Shared by Ravi (moved here from Example Community)');
  assert.equal(sent[1].options.quoted.key.id, 'SENT1');
  assert.deepEqual(sent[2].content, { delete: msg.key });
});

test('move mode: if the repost fails, the original is NOT removed', async () => {
  const sent = [];
  const { bot, store } = setup({
    settings: { mode: 'move' },
    sockOverrides: {
      async sendMessage(jid, content) {
        sent.push({ jid, content });
        throw new Error('whatsapp said no');
      },
    },
  });
  await bot.handle(text(JOB_TEXT));
  assert.equal(sent.length, 1, 'only the repost was attempted');
  assert.ok(!sent.some((s) => s.content.delete), 'nothing was deleted');
  assert.equal(store.activity.at(-1).outcome, 'error');
});

test('move mode where the bot is not an admin: reminds instead of removing', async () => {
  const { bot, sent, store } = setup({ settings: { mode: 'move' }, groupOverrides: { [MAIN]: { botAdmin: false } } });
  await bot.handle(text(JOB_TEXT));
  assert.equal(sent.length, 1);
  assert.ok(sent[0].options.quoted);
  assert.match(store.activity.at(-1).note, /not an admin/);
});

test('record-only mode sends nothing but notes what it spotted', async () => {
  const { bot, sent, store } = setup({ settings: { mode: 'watch' } });
  await bot.handle(text(JOB_TEXT));
  assert.equal(sent.length, 0);
  assert.equal(store.activity.at(-1).outcome, 'spotted');
});

test('a job post in the Jobs group is left alone', async () => {
  const { bot, sent, store } = setup();
  await bot.handle(text(JOB_TEXT, { group: JOBS }));
  assert.equal(sent.length, 0);
  assert.equal(store.activity.at(-1).outcome, 'left');
});

test('a job post in the Events group is caught too', async () => {
  const { bot, sent } = setup();
  await bot.handle(text(JOB_TEXT, { group: EVENTS }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, EVENTS);
});

test('general chat and unsure verdicts are left alone', async () => {
  for (const verdict of [{ labels: [], confidence: 0.99, reason: 'chat' }, { labels: ['jobs'], confidence: 0.55, reason: 'maybe' }]) {
    const { bot, sent } = setup({ verdict });
    await bot.handle(text('Has anyone tried the new open source model that came out this week?'));
    assert.equal(sent.length, 0);
  }
});

test('never even reads: short messages, own messages, other groups, old messages, repeats, stickers', async () => {
  const { bot, calls } = setup();
  await bot.handle(text('ok thanks'));
  await bot.handle(text(JOB_TEXT, { fromMe: true }));
  await bot.handle(text(JOB_TEXT, { group: 'RANDOM@g.us' }));
  await bot.handle(text(JOB_TEXT, { group: '111@s.whatsapp.net' }));
  await bot.handle(text(JOB_TEXT, { ageSec: 3600 }));
  await bot.handle(message({ stickerMessage: {} }));
  await bot.handle(message({ reactionMessage: { text: '👍' } }));
  await bot.handle(message({ protocolMessage: { type: 0 } }));
  assert.equal(calls.length, 0);
  const again = text(JOB_TEXT, { id: 'SAME' });
  await bot.handle(again);
  await bot.handle(again);
  assert.equal(calls.length, 1, 'the same message is only checked once');
});

test('disappearing-message wrappers and replies are understood', async () => {
  const { bot, calls } = setup();
  await bot.handle(message({ ephemeralMessage: { message: { extendedTextMessage: { text: JOB_TEXT, contextInfo: { quotedMessage: { conversation: 'hi' } } } } } }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, JOB_TEXT);
  assert.equal(calls[0].isReply, true);
});

test("admins' posts are left alone when that setting is on, by phone id or by hidden id", async () => {
  const on = setup();
  await on.bot.handle(text(JOB_TEXT, { from: '900:7@s.whatsapp.net' }));
  await on.bot.handle(text(JOB_TEXT, { from: '901@lid' }));
  const viaAlt = text(JOB_TEXT, { from: '777@lid' });
  viaAlt.key.participantAlt = '900@s.whatsapp.net';
  await on.bot.handle(viaAlt);
  assert.equal(on.calls.length, 0);

  const off = setup({ settings: { skipAdmins: false } });
  await off.bot.handle(text(JOB_TEXT, { from: '900@s.whatsapp.net' }));
  assert.equal(off.sent.length, 1);
});

test('paused, or no key: nothing is checked', async () => {
  const paused = setup({ settings: { paused: true } });
  await paused.bot.handle(text(JOB_TEXT));
  assert.equal(paused.calls.length, 0);

  const noKey = setup({ settings: { apiKey: '' } });
  await noKey.bot.handle(text(JOB_TEXT));
  assert.equal(noKey.calls.length, 0);
  assert.match(noKey.bot.state.aiProblem, /No AI key/);
});

test('an AI failure is recorded in plain words and nothing is sent', async () => {
  const { bot, sent, store } = setup({ verdict: new AiError('The AI key was rejected. Check that you copied the whole key.') });
  await bot.handle(text(JOB_TEXT));
  assert.equal(sent.length, 0);
  assert.match(bot.state.aiProblem, /key was rejected/);
  assert.equal(store.activity.at(-1).outcome, 'error');
});

test('the hourly limit stops a runaway bot', async () => {
  const { bot, sent, store } = setup({ settings: { maxActionsPerHour: 2 } });
  for (let i = 0; i < 4; i++) await bot.handle(text(JOB_TEXT));
  assert.equal(sent.length, 2);
  assert.match(store.activity.at(-1).note, /Hourly limit/);
});

test('connection: shows a code, links, lists groups, and recovers when unlinked from the phone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorter-'));
  const store = createStore(dir);
  const sockets = [];
  const makeSocket = async (authDir) => {
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, 'creds.json'), '{}');
    const sock = {
      ev: new EventEmitter(),
      user: { id: '12345:4@s.whatsapp.net', lid: '555:4@lid', name: 'Example Bot' },
      async groupFetchAllParticipating() {
        return {
          'C@g.us': { id: 'C@g.us', subject: 'Example Community', isCommunity: true, participants: [] },
          [MAIN]: { id: MAIN, subject: 'General', linkedParent: 'C@g.us', participants: [{ id: '555@lid', phoneNumber: '12345@s.whatsapp.net', admin: 'admin' }, { id: '42@lid', admin: null }] },
          [JOBS]: { id: JOBS, subject: 'Example Community Jobs', linkedParent: 'C@g.us', announce: true, participants: [{ id: '555@lid', admin: null }, { id: '42@lid', admin: 'superadmin' }] },
        };
      },
    };
    sockets.push(sock);
    return sock;
  };
  let resets = 0;
  const realReset = store.resetSession;
  store.resetSession = () => { resets += 1; realReset(); };
  const bot = createBot({ store, deps: { makeSocket, qrToDataUrl: async (qr) => `data:qr,${qr}`, log: () => {}, sleep: async () => {} } });
  const settle = () => new Promise((r) => setTimeout(r, 20));

  await bot.start();
  sockets[0].ev.emit('connection.update', { qr: 'CODE-1' });
  await settle();
  assert.equal(bot.state.connection, 'qr');
  assert.equal(bot.state.qr, 'data:qr,CODE-1');

  sockets[0].ev.emit('connection.update', { connection: 'open' });
  await settle();
  assert.equal(bot.state.connection, 'connected');
  assert.deepEqual(bot.state.me, { name: 'Example Bot', number: '12345' });
  assert.equal(bot.state.groups.size, 2, 'the community itself is not listed as a group');
  assert.equal(bot.state.groups.get(MAIN).botAdmin, true);
  assert.equal(bot.state.groups.get(MAIN).community, 'Example Community');
  assert.equal(bot.state.groups.get(JOBS).botAdmin, false);
  assert.equal(bot.state.groups.get(JOBS).adminsOnly, true);
  assert.ok(bot.state.groups.get(JOBS).adminIds.has('42@lid'));

  // The number gets unlinked from the phone: forget the session and ask for a new code.
  sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(sockets.length, 2, 'a fresh connection was started');
  assert.equal(resets, 1, 'the old WhatsApp session was forgotten');
  assert.equal(bot.state.me, null);
  assert.equal(bot.state.groups.size, 0);

  // Events from the old, dead connection are ignored.
  sockets[0].ev.emit('connection.update', { connection: 'open' });
  await settle();
  assert.notEqual(bot.state.connection, 'connected');
  bot.stop();
});

test('connection: no internet backs off and says so; an expired code is refreshed quickly', async () => {
  const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'sorter-')));
  const sockets = [];
  const makeSocket = async () => {
    const sock = { ev: new EventEmitter(), user: null };
    sockets.push(sock);
    return sock;
  };
  const bot = createBot({ store, deps: { makeSocket, qrToDataUrl: async (qr) => `data:qr,${qr}`, log: () => {} } });
  const timedOut = { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } };

  await bot.start();
  // WhatsApp cannot be reached: the first retry waits about 2 seconds, not half a second.
  sockets[0].ev.emit('connection.update', timedOut);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(sockets.length, 1, 'no instant retry loop when offline');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(sockets.length, 2);
  sockets[1].ev.emit('connection.update', timedOut);
  await new Promise((r) => setTimeout(r, 20));
  assert.match(bot.state.problem, /Cannot reach WhatsApp/);
  bot.stop();

  // A code that was on screen and expired is replaced within a second.
  const sockets2 = [];
  const bot2 = createBot({ store, deps: { makeSocket: async () => { const s = { ev: new EventEmitter() }; sockets2.push(s); return s; }, qrToDataUrl: async (qr) => `data:qr,${qr}`, log: () => {} } });
  await bot2.start();
  sockets2[0].ev.emit('connection.update', { qr: 'CODE' });
  await new Promise((r) => setTimeout(r, 20));
  sockets2[0].ev.emit('connection.update', timedOut);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(sockets2.length, 2);
  assert.equal(bot2.state.problem, null);
  bot2.stop();
});

test('unlinking forgets the number, logs out of WhatsApp and asks for a new code', async () => {
  const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'sorter-')));
  const sockets = [];
  const makeSocket = async (authDir) => {
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, 'creds.json'), `{"n":${sockets.length}}`);
    const sock = { ev: new EventEmitter(), user: { id: '91:1@s.whatsapp.net', name: 'Bot' }, loggedOut: false, async logout() { this.loggedOut = true; }, async groupFetchAllParticipating() { return {}; } };
    sockets.push(sock);
    return sock;
  };
  const bot = createBot({ store, deps: { makeSocket, qrToDataUrl: async (q) => q, log: () => {}, sleep: async () => {} } });
  await bot.start();
  sockets[0].ev.emit('connection.update', { connection: 'open' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bot.state.connection, 'connected');

  await bot.unlink();
  assert.equal(sockets[0].loggedOut, true);
  assert.equal(sockets.length, 2);
  assert.equal(bot.state.me, null);
  assert.equal(bot.state.connection, 'starting');
  assert.equal(fs.readFileSync(path.join(store.authDir, 'creds.json'), 'utf8'), '{"n":1}', 'only the new link is on disk');
  bot.stop();
});
