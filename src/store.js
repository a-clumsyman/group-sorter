// Keeps the bot's settings and its activity record on disk, inside the "data" folder.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MODES = ['watch', 'nudge', 'move'];

export const DEFAULT_CONFIG = {
  apiKey: '',
  model: 'claude-haiku-5-5',
  // watch = only keep a record, nudge = reply with a reminder, move = repost and remove.
  // Starts on "watch" so nothing is sent to the groups until the admin has seen its judgement.
  mode: 'watch',
  paused: false,
  threshold: 0.8, // how sure the AI must be before the bot acts
  skipAdmins: true,
  maxActionsPerHour: 20,
  topics: [
    {
      id: 'jobs',
      name: 'Jobs',
      description:
        'Job openings, internships, hiring posts, freelance or contract gigs, referrals, and people saying they are looking for work.',
      groupId: '',
    },
    {
      id: 'events',
      name: 'Events',
      description:
        'Meetups, workshops, hackathons, webinars, conferences, talks and other events with a date or a registration link.',
      groupId: '',
    },
    {
      id: 'grants',
      name: 'Grants',
      description:
        'Grants, funding calls, fellowships, startup credits, and accelerator or incubator applications.',
      groupId: '',
    },
  ],
  watchGroupIds: [],
  nudgeText:
    'This looks like a post about {topic}. Please share it in *{group}* so the right people see it. Thank you!',
  movedText:
    "{name}'s post has been moved to *{group}*, which is the place for {topic}. Thank you!",
  repostHeader: 'Shared by {name} (moved here from {from})',
};

const ACTIVITY_LIMIT = 300;

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function slug(name, taken) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'topic';
  let id = base === 'other' ? 'topic' : base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

/** Turns whatever was saved or submitted into a safe, complete settings object. */
export function cleanConfig(input = {}, base = DEFAULT_CONFIG) {
  const src = { ...base, ...input };
  const out = {
    apiKey: str(src.apiKey, 300),
    model: str(src.model, 80) || DEFAULT_CONFIG.model,
    mode: MODES.includes(src.mode) ? src.mode : DEFAULT_CONFIG.mode,
    paused: src.paused === true,
    threshold: Math.min(0.99, Math.max(0.5, Number(src.threshold) || DEFAULT_CONFIG.threshold)),
    skipAdmins: src.skipAdmins !== false,
    maxActionsPerHour: Math.min(200, Math.max(1, Math.round(Number(src.maxActionsPerHour)) || 20)),
    nudgeText: str(src.nudgeText, 500) || DEFAULT_CONFIG.nudgeText,
    movedText: str(src.movedText, 500) || DEFAULT_CONFIG.movedText,
    repostHeader: str(src.repostHeader, 200) || DEFAULT_CONFIG.repostHeader,
    topics: [],
    watchGroupIds: [],
  };

  const takenIds = new Set();
  const takenGroups = new Set();
  for (const t of Array.isArray(src.topics) ? src.topics.slice(0, 12) : []) {
    const name = str(t?.name, 40);
    if (!name) continue;
    let id = str(t?.id, 40).toLowerCase();
    if (!/^[a-z0-9-]+$/.test(id) || id === 'other' || takenIds.has(id)) id = slug(name, takenIds);
    takenIds.add(id);
    // One group can be the home of only one topic.
    let groupId = str(t?.groupId, 80);
    if (groupId && takenGroups.has(groupId)) groupId = '';
    if (groupId) takenGroups.add(groupId);
    out.topics.push({ id, name, description: str(t?.description, 400), groupId });
  }

  const watch = new Set();
  for (const g of Array.isArray(src.watchGroupIds) ? src.watchGroupIds : []) {
    const id = str(g, 80);
    if (id && !takenGroups.has(id)) watch.add(id);
  }
  out.watchGroupIds = [...watch].slice(0, 100);
  return out;
}

export function createStore(dataDir = process.env.GROUP_SORTER_DATA || path.join(ROOT, 'data')) {
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(dataDir, 'settings.json');
  const activityPath = path.join(dataDir, 'activity.jsonl');
  const authDir = path.join(dataDir, 'whatsapp-session');

  let config = cleanConfig(readJson(configPath) || {});
  let activity = readActivity();

  function readJson(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  function readActivity() {
    try {
      const lines = fs.readFileSync(activityPath, 'utf8').split('\n').filter(Boolean);
      const items = [];
      for (const line of lines.slice(-ACTIVITY_LIMIT)) {
        try {
          items.push(JSON.parse(line));
        } catch {
          /* skip a damaged line */
        }
      }
      // Trim the file so it never grows without limit.
      if (lines.length > ACTIVITY_LIMIT * 2) {
        fs.writeFileSync(activityPath, items.map((i) => JSON.stringify(i)).join('\n') + '\n');
      }
      return items;
    } catch {
      return [];
    }
  }

  function writeConfig() {
    const tmp = configPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, configPath);
  }

  return {
    dataDir,
    authDir,
    get config() {
      return config;
    },
    get activity() {
      return activity;
    },
    update(patch) {
      config = cleanConfig({ ...config, ...patch });
      writeConfig();
      return config;
    },
    addActivity(entry) {
      const item = { t: Date.now(), ...entry };
      activity.push(item);
      if (activity.length > ACTIVITY_LIMIT) activity = activity.slice(-ACTIVITY_LIMIT);
      try {
        fs.appendFileSync(activityPath, JSON.stringify(item) + '\n');
      } catch {
        /* the record on screen still works */
      }
      return item;
    },
    /** Forgets the linked WhatsApp number so a fresh QR code is shown. */
    resetSession() {
      fs.rmSync(authDir, { recursive: true, force: true });
    },
  };
}
