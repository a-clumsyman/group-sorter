// Decides whether a post is in the wrong group and, if so, where it belongs.
// No WhatsApp or AI code here, so it is easy to test.

/** Every group the bot should read: the topic groups plus the extra ones ticked in the settings. */
export function watchedGroupIds(config) {
  const ids = new Set(config.watchGroupIds || []);
  for (const topic of config.topics || []) if (topic.groupId) ids.add(topic.groupId);
  return ids;
}

/**
 * @param {object} input
 * @param {string} input.groupId      where the post was made
 * @param {string[]} input.labels     topic ids the AI says the post fits, best fit first
 * @param {number} input.confidence   0 to 1
 * @param {object} input.config       the settings
 * @returns {{misplaced: false, why: string} | {misplaced: true, topic: object, targetGroupId: string}}
 */
export function decide({ groupId, labels, confidence, config }) {
  const topics = config.topics || [];
  const fits = (labels || []).map((id) => topics.find((t) => t.id === id)).filter(Boolean);

  if (fits.length === 0) return { misplaced: false, why: 'General chat' };
  if (fits.some((t) => t.groupId === groupId)) return { misplaced: false, why: 'Already in the right group' };
  if (confidence < config.threshold) return { misplaced: false, why: 'Not sure enough to act' };

  const topic = fits.find((t) => t.groupId);
  if (!topic) return { misplaced: false, why: `No group chosen for ${fits[0].name}` };
  return { misplaced: true, topic, targetGroupId: topic.groupId };
}

/** Fills {placeholders} in the message wordings. Unknown placeholders are left as they are. */
export function fill(template, values) {
  return String(template || '').replace(/\{(\w+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
  );
}
