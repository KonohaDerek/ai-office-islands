import assert from 'node:assert/strict';
import test from 'node:test';
import {isDuplicateNotification} from '../src/notification-utils.mjs';

const candidate = {officeId: 'office-1', type: 'quota', title: '額度偏低', targetId: ''};

test('quota notifications deduplicate per office and title for six hours', () => {
  const now = Date.now();
  const existing = [{...candidate, createdAt: new Date(now - 1000).toISOString()}];
  assert.equal(isDuplicateNotification(existing, candidate, now), true);
  assert.equal(isDuplicateNotification(existing, {...candidate, officeId: 'office-2'}, now), false);
  assert.equal(isDuplicateNotification(existing, {...candidate, title: '另一個額度'}, now), false);
  assert.equal(isDuplicateNotification([{...existing[0], createdAt: new Date(now - 6 * 60 * 60 * 1000).toISOString()}], candidate, now), false);
});

test('other repeated events deduplicate briefly, allowing later events through', () => {
  const now = Date.now();
  const event = {...candidate, type: 'error', title: '任務失敗', createdAt: new Date(now - 5000).toISOString()};
  assert.equal(isDuplicateNotification([event], event, now), true);
  assert.equal(isDuplicateNotification([{...event, createdAt: new Date(now - 30_000).toISOString()}], event, now), false);
});

test('notification targets must still exist in the active office', async () => {
  const {notificationTargetExists} = await import('../src/notification-utils.mjs');
  const item = {...candidate, targetId: 'group-1'};
  assert.equal(notificationTargetExists(item, 'office-1', [{id: 'group-1'}], []), true);
  assert.equal(notificationTargetExists(item, 'office-1', [], []), false);
  assert.equal(notificationTargetExists(item, 'office-2', [{id: 'group-1'}], []), false);
  assert.equal(notificationTargetExists({...item, targetId: ''}, 'office-1', [], []), true);
});
