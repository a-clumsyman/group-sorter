import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, fill, watchedGroupIds } from '../src/router.js';
import { cleanConfig, DEFAULT_CONFIG } from '../src/store.js';

const config = cleanConfig({
  topics: [
    { id: 'jobs', name: 'Jobs', description: 'x', groupId: 'JOBS@g.us' },
    { id: 'events', name: 'Events', description: 'x', groupId: 'EVENTS@g.us' },
    { id: 'grants', name: 'Grants', description: 'x', groupId: '' },
  ],
  watchGroupIds: ['MAIN@g.us'],
  threshold: 0.8,
});

test('a job post in the main group belongs in Jobs', () => {
  const d = decide({ groupId: 'MAIN@g.us', labels: ['jobs'], confidence: 0.95, config });
  assert.equal(d.misplaced, true);
  assert.equal(d.targetGroupId, 'JOBS@g.us');
  assert.equal(d.topic.name, 'Jobs');
});

test('a job post in the events group belongs in Jobs', () => {
  const d = decide({ groupId: 'EVENTS@g.us', labels: ['jobs'], confidence: 0.9, config });
  assert.equal(d.targetGroupId, 'JOBS@g.us');
});

test('a job post already in Jobs is left alone', () => {
  assert.equal(decide({ groupId: 'JOBS@g.us', labels: ['jobs'], confidence: 0.99, config }).misplaced, false);
});

test('a post that fits two topics stays if it is in either group', () => {
  const d = decide({ groupId: 'EVENTS@g.us', labels: ['jobs', 'events'], confidence: 0.95, config });
  assert.equal(d.misplaced, false);
  assert.equal(d.why, 'Already in the right group');
});

test('general chat is left alone everywhere', () => {
  for (const groupId of ['MAIN@g.us', 'JOBS@g.us']) {
    assert.equal(decide({ groupId, labels: [], confidence: 0.99, config }).misplaced, false);
  }
});

test('low confidence is left alone', () => {
  const d = decide({ groupId: 'MAIN@g.us', labels: ['jobs'], confidence: 0.6, config });
  assert.deepEqual(d, { misplaced: false, why: 'Not sure enough to act' });
});

test('a topic with no group chosen is left alone', () => {
  const d = decide({ groupId: 'MAIN@g.us', labels: ['grants'], confidence: 0.95, config });
  assert.equal(d.misplaced, false);
  assert.match(d.why, /No group chosen for Grants/);
});

test('falls through to the next fitting topic that has a group', () => {
  const d = decide({ groupId: 'MAIN@g.us', labels: ['grants', 'events'], confidence: 0.95, config });
  assert.equal(d.targetGroupId, 'EVENTS@g.us');
});

test('unknown labels from the AI are ignored', () => {
  assert.equal(decide({ groupId: 'MAIN@g.us', labels: ['spam'], confidence: 1, config }).misplaced, false);
});

test('watched groups are the topic groups plus the ticked ones', () => {
  assert.deepEqual([...watchedGroupIds(config)].sort(), ['EVENTS@g.us', 'JOBS@g.us', 'MAIN@g.us']);
});

test('fill replaces known placeholders and keeps unknown ones', () => {
  assert.equal(fill('Hi {name}, go to *{group}* {x}', { name: 'Ravi', group: 'Jobs' }), 'Hi Ravi, go to *Jobs* {x}');
});

test('settings are cleaned: one group per topic, bad values replaced', () => {
  const c = cleanConfig({
    mode: 'explode',
    threshold: 7,
    topics: [
      { name: 'Jobs', groupId: 'A@g.us' },
      { name: 'Events', groupId: 'A@g.us' },
      { name: '   ' },
      { id: 'other', name: 'Other stuff' },
    ],
    watchGroupIds: ['A@g.us', 'B@g.us', 'B@g.us', 5],
  });
  assert.equal(c.mode, DEFAULT_CONFIG.mode);
  assert.equal(c.threshold, 0.99);
  assert.equal(c.topics.length, 3);
  assert.equal(c.topics[0].groupId, 'A@g.us');
  assert.equal(c.topics[1].groupId, '');
  assert.notEqual(c.topics[2].id, 'other');
  assert.equal(new Set(c.topics.map((t) => t.id)).size, 3);
  assert.deepEqual(c.watchGroupIds, ['B@g.us']);
});
