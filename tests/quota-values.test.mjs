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

test('quota source signatures change when connected or logged-in sources change', async () => {
  const {quotaSourceSignature} = await import('../src/quota-utils.mjs');
  assert.equal(quotaSourceSignature({}, {}), '');
  assert.notEqual(quotaSourceSignature({}, {}), quotaSourceSignature({Grok: {connected: true}}, {}));
  assert.notEqual(quotaSourceSignature({}, {}), quotaSourceSignature({}, {CodexOAuth: {loggedIn: true}}));
});

test('roles never default to the read-only Codex CLI archive runtime', async () => {
  const {initialRoleRuntimeSource, resolveRoleRuntimeSource} = await import('../src/quota-utils.mjs');
  assert.equal(initialRoleRuntimeSource('CodexCLI', {CodexCLI: {connected: true}}), '');
  assert.equal(initialRoleRuntimeSource('Hermes', {Hermes: {connected: true}}), 'Hermes');
  assert.equal(initialRoleRuntimeSource('Hermes', {Hermes: {connected: false}}), '');
  assert.equal(resolveRoleRuntimeSource('CodexCLI', 'Grok'), 'Grok');
});

test('missing reset dates stay unknown instead of becoming the Unix epoch', async () => {
  const {formatQuotaDate} = await import('../src/quota-utils.mjs');
  assert.equal(formatQuotaDate(null), '供應商未提供');
  assert.equal(formatQuotaDate(undefined), '供應商未提供');
  assert.equal(formatQuotaDate(''), '供應商未提供');
  assert.equal(formatQuotaDate('not-a-date'), '供應商未提供');
});
