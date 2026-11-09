import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import {
  MAX_BODY_BYTES,
  MAX_PROMPT_CHARS,
  openDeliveryToken,
  parseAgentCommand,
  parseDiscordCommand,
  sealDeliveryToken,
  verifyDiscordRequest,
} from './core.mjs';

test('Telegram command parser accepts ask/task and rejects malformed or oversized prompts', () => {
  assert.deepEqual(parseAgentCommand('/ask future Check this'), {kind: 'task', intent: 'ask', agentId: 'future', prompt: 'Check this'});
  assert.equal(parseAgentCommand('/task@my_bot future Do it').intent, 'task');
  assert.equal(parseAgentCommand('/ask').kind, 'invalid');
  assert.equal(parseAgentCommand(`/ask future ${'x'.repeat(MAX_PROMPT_CHARS + 1)}`).kind, 'invalid');
  assert.equal(parseAgentCommand('hello').kind, 'none');
});

test('Discord parser accepts only named single-Agent ask/task commands', () => {
  const interaction = {type: 2, data: {name: 'ai-office', options: [{type: 1, name: 'task', options: [{name: 'agent', value: 'future'}, {name: 'prompt', value: 'Ship nothing'}]}]}};
  assert.deepEqual(parseDiscordCommand(interaction), {kind: 'task', intent: 'task', agentId: 'future', prompt: 'Ship nothing'});
  assert.equal(parseDiscordCommand({...interaction, data: {...interaction.data, options: []}}).kind, 'invalid');
});

test('Discord verification uses timestamp plus exact raw body and rejects stale requests', async () => {
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  const raw = Buffer.from('{ "type": 1 }');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.concat([Buffer.from(timestamp), raw]), privateKey).toString('hex');
  const publicKeyHex = publicKey.export({format: 'der', type: 'spki'}).subarray(-32).toString('hex');
  assert.equal(await verifyDiscordRequest({signature, timestamp, body: raw, publicKey: publicKeyHex}), true);
  assert.equal(await verifyDiscordRequest({signature, timestamp, body: Buffer.from('{"type":1}'), publicKey: publicKeyHex}), false);
  assert.equal(await verifyDiscordRequest({signature, timestamp: '1', body: raw, publicKey: publicKeyHex}), false);
});

test('Discord delivery token metadata is encrypted and round-trips', async () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const sealed = await sealDeliveryToken('short-lived-discord-token', key);
  assert.notEqual(sealed, 'short-lived-discord-token');
  assert.equal(await openDeliveryToken(sealed, key), 'short-lived-discord-token');
  await assert.rejects(openDeliveryToken(sealed, Buffer.alloc(32, 8).toString('base64')));
});

test('limits fit the planned ingress contract', () => {
  assert.equal(MAX_BODY_BYTES, 16 * 1024);
  assert.equal(MAX_PROMPT_CHARS, 12_000);
});
