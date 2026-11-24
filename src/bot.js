// The bot: stays connected to WhatsApp, reads new posts in the watched groups,
// asks the AI what each post is about, and reminds people or moves the post.

import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  jidNormalizedUser,
} from 'baileys';
import pino from 'pino';
import QRCode from 'qrcode';

import { classify as realClassify, AiError } from './classifier.js';
import { decide, fill, watchedGroupIds } from './router.js';
import { extractPost, messageTimeMs } from './extract.js';

const MIN_TEXT_LENGTH = 20; // shorter text-only messages are chat, not posts
const MAX_IMAGE_BYTES = 4_500_000;
const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000; // ignore old messages delivered after a reconnect
const SEEN_LIMIT = 2000;

const silentLogger = pino({ level: 'silent' });
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let cachedVersion = null;
let cachedVersionAt = 0;

/** Looks up the WhatsApp version the library currently recommends, at most once an hour. */
async function latestVersion() {
  if (cachedVersion && Date.now() - cachedVersionAt < 60 * 60 * 1000) return cachedVersion;
  try {
    const latest = await Promise.race([fetchLatestBaileysVersion(), sleepFor(8000)]);
    if (latest?.version && !latest.error) {
      cachedVersion = latest.version;
      cachedVersionAt = Date.now();
    }
  } catch {
    /* fall back to the version built into the library */
  }
  return cachedVersion;
}

// Messages the bot sent recently. If a phone could not read one, WhatsApp asks for it again.
const sentMessages = new Map();
function rememberSent(result) {
  if (!result?.key?.id || !result.message) return;
  sentMessages.set(result.key.id, result.message);
  if (sentMessages.size > 500) sentMessages.delete(sentMessages.keys().next().value);
}

async function defaultMakeSocket(authDir) {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const version = await latestVersion();
  const sock = makeWASocket({
    auth: state,
    logger: silentLogger,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    getMessage: async (key) => sentMessages.get(key.id),
    ...(version ? { version } : {}),
  });
  sock.ev.on('creds.update', saveCreds);
  return sock;
}

async function defaultDownloadImage(msg, sock) {
  return downloadMediaMessage(msg, 'buffer', {}, { logger: silentLogger, reuploadRequest: sock.updateMediaMessage });
}

const normalize = (jid) => {
  try {
    return jid ? jidNormalizedUser(jid) : '';
  } catch {
    return '';
  }
};

const phoneFromJid = (jid) => (jid || '').split('@')[0].split(':')[0];

export function createBot({ store, deps = {} }) {
  const d = {
    makeSocket: defaultMakeSocket,
    classify: realClassify,
    downloadImage: defaultDownloadImage,
    qrToDataUrl: (qr) => QRCode.toDataURL(qr, { margin: 2, width: 320 }),
    sleep: sleepFor,
    now: () => Date.now(),
    random: Math.random,
    log: (line) => console.log(line),
    ...deps,
  };

  const state = {
    connection: 'starting', // starting | qr | connected | reconnecting
    qr: null,
    me: null,
    problem: null, // trouble with the WhatsApp link, in plain words
    aiProblem: null, // trouble with the AI key or service, in plain words
    groups: new Map(),
  };

  let sock = null;
  let generation = 0;
  let retries = 0;
  let reconnectTimer = null;
  let groupsTimer = null;
  let stopped = false;
  let codeShown = false; // true once the current connection has shown a code to scan
  let queue = Promise.resolve();
  const seen = new Set();
  const actionTimes = [];

  // ---------- connection ----------

  async function connect() {
    if (stopped) return;
    const gen = ++generation;
    let s;
    try {
      s = await d.makeSocket(store.authDir);
    } catch (err) {
      state.problem = 'Could not start the WhatsApp connection. Trying again shortly.';
      d.log(`WhatsApp connection could not start: ${err?.message || err}`);
      scheduleReconnect();
      return;
    }
    if (gen !== generation || stopped) return;
    sock = s;
    codeShown = false;

    s.ev.on('connection.update', (update) => {
      if (gen !== generation) return;
      onConnectionUpdate(update, s).catch((err) => d.log(`Connection update failed: ${err?.message || err}`));
    });
    s.ev.on('messages.upsert', ({ messages, type }) => {
      if (gen !== generation || type !== 'notify') return;
      for (const msg of messages || []) enqueue(msg);
    });
    for (const event of ['groups.update', 'groups.upsert', 'group-participants.update']) {
      s.ev.on(event, () => {
        if (gen === generation) refreshGroupsSoon();
      });
    }
  }

  async function onConnectionUpdate(update, s) {
    if (update.qr) {
      codeShown = true;
      retries = 0;
      state.qr = await d.qrToDataUrl(update.qr);
      state.connection = 'qr';
      state.problem = null;
    }

    if (update.connection === 'open') {
      retries = 0;
      state.connection = 'connected';
      state.qr = null;
      state.problem = null;
      state.me = { name: s.user?.name || '', number: phoneFromJid(s.user?.id) };
      d.log(`WhatsApp linked${state.me.number ? ` as +${state.me.number}` : ''}.`);
      await refreshGroups().catch(() => refreshGroupsSoon(5000));
    }

    if (update.connection === 'close') {
      const code = update.lastDisconnect?.error?.output?.statusCode;
      state.qr = null;

      if (code === DisconnectReason.loggedOut) {
        // The number was unlinked from the phone. Forget it and show a new code.
        store.resetSession();
        state.me = null;
        state.groups = new Map();
        state.connection = 'starting';
        state.problem = null;
        d.log('WhatsApp was unlinked. Showing a new code.');
        scheduleReconnect(500);
        return;
      }
      if (code === DisconnectReason.restartRequired) {
        scheduleReconnect(200); // normal right after scanning the code
        return;
      }

      state.connection = state.me ? 'reconnecting' : 'starting';
      if (code === DisconnectReason.connectionReplaced) {
        state.problem = 'This WhatsApp link was opened somewhere else. If the bot is running twice, close the other one.';
        scheduleReconnect(30_000);
      } else if (code === DisconnectReason.forbidden) {
        state.problem = 'WhatsApp refused this number. It may have been restricted. Check WhatsApp on the phone.';
        scheduleReconnect(60_000);
      } else if (code === DisconnectReason.timedOut && codeShown) {
        scheduleReconnect(500); // the code on screen expired; fetch a fresh one
      } else {
        if (retries >= 1) state.problem = 'Cannot reach WhatsApp. Check the internet connection. Trying again.';
        scheduleReconnect();
      }
    }
  }

  function scheduleReconnect(delay) {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    const wait = delay ?? Math.min(60_000, 2000 * 2 ** Math.min(retries, 5));
    if (delay == null) retries += 1;
    reconnectTimer = setTimeout(() => connect(), wait);
    reconnectTimer.unref?.();
  }

  // ---------- groups ----------

  async function refreshGroups() {
    if (!sock || state.connection !== 'connected') return;
    const all = await sock.groupFetchAllParticipating();
    const selfIds = new Set([sock.user?.id, sock.user?.lid].map(normalize).filter(Boolean));
    const communityNames = new Map();
    for (const g of Object.values(all)) if (g.isCommunity) communityNames.set(g.id, g.subject);

    const next = new Map();
    for (const g of Object.values(all)) {
      if (g.isCommunity) continue; // the community itself is not a chat people post in
      const adminIds = new Set();
      let botAdmin = null; // null = could not tell
      for (const p of g.participants || []) {
        const ids = [p.id, p.lid, p.phoneNumber].map(normalize).filter(Boolean);
        const isAdmin = Boolean(p.admin || p.isAdmin || p.isSuperAdmin);
        if (isAdmin) ids.forEach((id) => adminIds.add(id));
        if (ids.some((id) => selfIds.has(id))) botAdmin = isAdmin;
      }
      next.set(g.id, {
        id: g.id,
        name: g.subject || 'Unnamed group',
        community: communityNames.get(g.linkedParent) || '',
        adminsOnly: Boolean(g.announce),
        botAdmin,
        adminIds,
      });
    }
    state.groups = next;
  }

  function refreshGroupsSoon(delay = 3000) {
    clearTimeout(groupsTimer);
    groupsTimer = setTimeout(() => refreshGroups().catch(() => {}), delay);
    groupsTimer.unref?.();
  }

  const groupName = (id) => state.groups.get(id)?.name || 'the right group';

  function isFromAdmin(msg) {
    const group = state.groups.get(msg.key.remoteJid);
    if (!group) return false;
    return [msg.key.participant, msg.key.participantAlt].map(normalize).some((id) => id && group.adminIds.has(id));
  }

  // ---------- reading posts ----------

  function enqueue(msg) {
    queue = queue
      .then(() => handleMessage(msg))
      .catch((err) => d.log(`Could not handle a message: ${err?.message || err}`));
    return queue;
  }

  async function handleMessage(msg) {
    const config = store.config;
    const groupId = msg?.key?.remoteJid;
    if (config.paused || !groupId?.endsWith('@g.us') || msg.key.fromMe) return;
    if (!watchedGroupIds(config).has(groupId)) return;

    if (seen.has(msg.key.id)) return;
    seen.add(msg.key.id);
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value);

    const sentAt = messageTimeMs(msg);
    if (sentAt && d.now() - sentAt > MAX_MESSAGE_AGE_MS) return;

    const post = extractPost(msg);
    if (!post) return;
    if (post.kind !== 'image' && post.text.length < MIN_TEXT_LENGTH) return;
    if (config.skipAdmins && isFromAdmin(msg)) return;
    if (config.topics.length === 0) return;

    const record = {
      group: groupName(groupId),
      sender: msg.pushName || 'A member',
      snippet: post.text ? post.text.slice(0, 160) : `(${post.kind} with no text)`,
    };

    if (!config.apiKey) {
      state.aiProblem = 'No AI key saved yet, so posts are not being checked.';
      return;
    }

    let image = null;
    if (post.kind === 'image') {
      try {
        const data = await d.downloadImage(msg, sock);
        if (data?.length && data.length <= MAX_IMAGE_BYTES) {
          image = { data, mimetype: (post.image.mimetype || 'image/jpeg').split(';')[0] };
        }
      } catch {
        /* fall back to the caption alone */
      }
      if (!image && post.text.length < MIN_TEXT_LENGTH) return;
    }

    let verdict;
    try {
      verdict = await d.classify({
        text: post.text,
        image,
        isReply: post.isReply,
        topics: config.topics,
        apiKey: config.apiKey,
        model: config.model,
      });
      state.aiProblem = null;
    } catch (err) {
      state.aiProblem = err instanceof AiError ? err.message : 'The AI check failed. The bot will keep trying.';
      store.addActivity({ ...record, outcome: 'error', note: state.aiProblem });
      return;
    }

    const decision = decide({ groupId, labels: verdict.labels, confidence: verdict.confidence, config });
    const details = { ...record, confidence: verdict.confidence, reason: verdict.reason };

    if (!decision.misplaced) {
      store.addActivity({ ...details, outcome: 'left', note: decision.why });
      return;
    }

    const target = { topic: decision.topic.name, to: groupName(decision.targetGroupId) };
    if (config.mode === 'watch') {
      store.addActivity({ ...details, ...target, outcome: 'spotted', note: 'Record only, nothing sent' });
      return;
    }

    const cutoff = d.now() - 60 * 60 * 1000;
    while (actionTimes.length && actionTimes[0] < cutoff) actionTimes.shift();
    if (actionTimes.length >= config.maxActionsPerHour) {
      store.addActivity({ ...details, ...target, outcome: 'spotted', note: 'Hourly limit reached, nothing sent' });
      return;
    }
    actionTimes.push(d.now());

    try {
      // A short, uneven pause so the bot does not answer instantly every time.
      await d.sleep(2000 + Math.floor(d.random() * 4000));
      const group = state.groups.get(groupId);
      const canRemove = group?.botAdmin !== false;
      if (config.mode === 'move' && canRemove) {
        await movePost({ msg, post, image, groupId, decision, config });
        store.addActivity({ ...details, ...target, outcome: 'moved' });
      } else {
        await remind({ msg, groupId, decision, config });
        const note = config.mode === 'move' ? 'Reminded only: the bot is not an admin in this group' : undefined;
        store.addActivity({ ...details, ...target, outcome: 'reminded', note });
      }
    } catch (err) {
      d.log(`Could not act on a post: ${err?.message || err}`);
      store.addActivity({ ...details, ...target, outcome: 'error', note: 'WhatsApp did not accept the message. Will try with the next post.' });
    }
  }

  // ---------- acting ----------

  async function send(jid, content, options) {
    if (!sock) throw new Error('WhatsApp is not connected');
    const result = await sock.sendMessage(jid, content, options);
    rememberSent(result);
    return result;
  }

  function words(msg, groupId, decision) {
    return {
      name: msg.pushName || 'A member',
      topic: decision.topic.name.toLowerCase(),
      group: groupName(decision.targetGroupId),
      from: groupName(groupId),
    };
  }

  async function remind({ msg, groupId, decision, config }) {
    const text = fill(config.nudgeText, words(msg, groupId, decision));
    await send(groupId, { text }, { quoted: msg });
  }

  async function movePost({ msg, post, image, groupId, decision, config }) {
    const values = words(msg, groupId, decision);
    const header = fill(config.repostHeader, values);
    const target = decision.targetGroupId;

    await repost({ msg, post, image, header, target });
    await d.sleep(1000 + Math.floor(d.random() * 1500));
    await send(groupId, { delete: msg.key });
    await d.sleep(800 + Math.floor(d.random() * 1200));
    await send(groupId, { text: fill(config.movedText, values) });
  }

  async function repost({ msg, post, image, header, target }) {
    if (post.kind === 'text') {
      await send(target, { text: `${header}\n\n${post.text}` });
      return;
    }
    if (post.kind === 'image' && image) {
      try {
        await send(target, {
          image: image.data,
          mimetype: image.mimetype,
          caption: [header, post.text].filter(Boolean).join('\n\n'),
          // Reuse the original preview so no image tools are needed on this computer.
          ...(post.image.jpegThumbnail ? { jpegThumbnail: post.image.jpegThumbnail } : {}),
          ...(post.image.width ? { width: post.image.width, height: post.image.height } : {}),
        });
        return;
      } catch {
        /* fall through to forwarding */
      }
    }
    // Videos, files, events, and images that could not be re-sent: forward, then credit the sender.
    const forwarded = await send(target, { forward: msg });
    await d.sleep(600);
    await send(target, { text: header }, forwarded ? { quoted: forwarded } : undefined);
  }

  // ---------- controls ----------

  return {
    state,
    start: () => connect(),
    /** Used by tests and by the message event. Resolves when the post has been dealt with. */
    handle: (msg) => enqueue(msg),
    refreshGroups,
    async unlink() {
      clearTimeout(reconnectTimer);
      const old = sock;
      generation += 1; // stop listening to the old connection
      sock = null;
      try {
        old?.ev?.removeAllListeners?.('creds.update'); // the old link must not save over the new one
        if (old && state.connection === 'connected') await old.logout();
        else old?.end?.(undefined);
      } catch {
        /* forgetting the session below is what matters */
      }
      await d.sleep(300);
      store.resetSession();
      state.me = null;
      state.qr = null;
      state.groups = new Map();
      state.problem = null;
      state.connection = 'starting';
      retries = 0;
      await connect();
    },
    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      clearTimeout(groupsTimer);
      generation += 1;
      try {
        sock?.end?.(undefined);
      } catch {
        /* already closed */
      }
    },
    /** For tests: plug in a ready-made connection. */
    _attach(fakeSock, groups) {
      sock = fakeSock;
      state.connection = 'connected';
      if (groups) state.groups = groups;
    },
  };
}
