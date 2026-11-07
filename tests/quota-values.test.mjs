import assert from 'node:assert/strict';
import test from 'node:test';
import {clampQuotaPercent, finiteQuotaNumber, quotaStatus} from '../server/quota-values.mjs';

test('missing quota numbers remain unknown instead of becoming zero', () => {
  for (const value of [null, undefined, '']) assert.equal(finiteQuotaNumber(value), null);
  assert.equal(clampQuotaPercent(null), null);
  assert.equal(finiteQuotaNumber('0'), 0);
});

test('quota percentages are finite and clamped', () => {
  assert.equal(clampQuotaPercent(-3), 0);
  assert.equal(clampQuotaPercent(140), 100);
  assert.equal(clampQuotaPercent('bad'), null);
});

test('quota status distinguishes unsupported, failed, unknown, and exhausted', () => {
  assert.equal(quotaStatus({supported: false}), 'unsupported');
  assert.equal(quotaStatus({supported: true, quota: {available: false}}), 'failed');
  assert.equal(quotaStatus({supported: true, quota: {available: true, windows: []}}), 'unknown');
  assert.equal(quotaStatus({supported: true, quota: {available: true, windows: [{remainingPercent: null}]}}), 'unknown');
  assert.equal(quotaStatus({supported: true, quota: {available: true, windows: [{remainingPercent: 0}]}}), 'exhausted');
  assert.equal(quotaStatus({supported: true, quota: {available: true, windows: [{remainingPercent: 0}, {remainingPercent: 4}]}}), 'available');
});
