import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import worker from './index.mjs';
import {deliverPendingTask} from './index.mjs';
import {sealDeliveryToken} from './core.mjs';

function harness() {
  const tasks = [];
  const queue = {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/tasks' && request.method === 'POST') {
        const input = await request.json();
        tasks.push(input);
        return Response.json({created: true, id: `task-${tasks.length}`, status: 'queued'}, {status: 201});
      }
      return Response.json({});
    },
  };
  const env = {
    TELEGRAM_WEBHOOK_SECRET: 'telegram-secret',
    TELEGRAM_BOT_TOKEN: 'fake-token',
    ALLOWED_TELEGRAM_CHAT_IDS: '123',
    ALLOWED_DISCORD_GUILD_IDS: '456',
    ALLOWED_DISCORD_USER_IDS: '789',
    ENABLED_AGENT_IDS: 'future',
    DISCORD_PUBLIC_KEY: '',
    DELIVERY_TOKEN_KEY: Buffer.alloc(32, 1).toString('base64'),
    TASK_QUEUE: {getByName: () => queue},
    INSTALLATION_ID: 'test',
  };
  const promises = [];
  const ctx = {waitUntil(promise) { promises.push(promise); }};
  return {env, tasks, ctx, promises};
}

test('Telegram requires webhook secret and allowlisted chat before enqueue', async () => {
  const h = harness();
  const payload = JSON.stringify({update_id: 9, message: {text: '/ask future summarize', chat: {id: 123}, from: {id: 44}}});
  let response = await worker.fetch(new Request('https://worker.test/webhooks/telegram', {method: 'POST', headers: {'x-telegram-bot-api-secret-token': 'wrong'}, body: payload}), h.env, h.ctx);
  assert.equal(response.status, 401);
  response = await worker.fetch(new Request('https://worker.test/webhooks/telegram', {method: 'POST', headers: {'x-telegram-bot-api-secret-token': 'telegram-secret'}, body: payload}), h.env, h.ctx);
  assert.equal(response.status, 200);
  assert.equal(h.tasks.length, 1);
  assert.equal(h.tasks[0].task.agentId, 'future');
  const deniedPayload = payload.replace('"id":123', '"id":999');
  await worker.fetch(new Request('https://worker.test/webhooks/telegram', {method: 'POST', headers: {'x-telegram-bot-api-secret-token': 'telegram-secret'}, body: deniedPayload}), h.env, h.ctx);
  assert.equal(h.tasks.length, 1);
  await Promise.all(h.promises);
});

test('Discord PING is answered and signed allowed commands are queued', async () => {
  const h = harness();
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  h.env.DISCORD_PUBLIC_KEY = publicKey.export({format: 'der', type: 'spki'}).subarray(-32).toString('hex');
  const invoke = async payload => {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]), privateKey).toString('hex');
    return worker.fetch(new Request('https://worker.test/webhooks/discord', {method: 'POST', headers: {'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp}, body}), h.env, h.ctx);
  };
  let response = await invoke({type: 1});
  assert.deepEqual(await response.json(), {type: 1});
  response = await invoke({type: 2, id: '1001', application_id: 'app', token: 'short-lived', guild_id: '456', channel_id: '1234', member: {user: {id: '789'}}, data: {name: 'ai-office', options: [{type: 1, name: 'ask', options: [{name: 'agent', value: 'future'}, {name: 'prompt', value: 'Review'}]}]}});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).type, 5);
  assert.equal(h.tasks.length, 1);
  assert.equal(h.tasks[0].task.source, 'discord');
  assert.equal(h.tasks[0].delivery.token, 'short-lived');
});

test('Discord rejects an unauthorized user before task creation', async () => {
  const h = harness();
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  h.env.DISCORD_PUBLIC_KEY = publicKey.export({format: 'der', type: 'spki'}).subarray(-32).toString('hex');
  const payload = {type: 2, id: '1002', application_id: 'app', token: 'token', guild_id: '456', member: {user: {id: 'not-allowed'}}, data: {name: 'ai-office', options: [{type: 1, name: 'task', options: [{name: 'agent', value: 'future'}, {name: 'prompt', value: 'Do this'}]}]}};
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]), privateKey).toString('hex');
  const response = await worker.fetch(new Request('https://worker.test/webhooks/discord', {method: 'POST', headers: {'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp}, body}), h.env, h.ctx);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).type, 4);
  assert.equal(h.tasks.length, 0);
});

test('completed Telegram task is delivered and delivery state is recorded', async () => {
  let deliveryState;
  const queue = {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/delivery')) return Response.json({task: {id: '00000000-0000-4000-8000-000000000001', result: 'Done', error: null}, delivery: {source: 'telegram', sourceId: '123'}});
      if (url.pathname.endsWith('/delivery-status')) { deliveryState = await request.json(); return Response.json({status: 'completed'}); }
      return Response.json({}, {status: 404});
    },
  };
  const previousFetch = globalThis.fetch;
  let deliveredText = '';
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /api\.telegram\.org/);
    deliveredText = JSON.parse(options.body).text;
    return new Response('{}', {status: 200});
  };
  try {
    assert.equal(await deliverPendingTask({TASK_QUEUE: {getByName: () => queue}, TELEGRAM_BOT_TOKEN: 'fake'}, '00000000-0000-4000-8000-000000000001'), true);
    assert.match(deliveredText, /Done/);
    assert.deepEqual(deliveryState, {delivered: true, error: ''});
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Discord completion token is decrypted only for follow-up delivery', async () => {
  let deliveryState;
  const key = Buffer.alloc(32, 3).toString('base64');
  const sealedToken = await sealDeliveryToken('interaction-secret', key);
  const queue = {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/delivery')) return Response.json({task: {id: '00000000-0000-4000-8000-000000000002', result: 'Discord result', error: null}, delivery: {source: 'discord', applicationId: 'application-id', sealedToken, expiresAt: Date.now() + 30_000}});
      if (url.pathname.endsWith('/delivery-status')) { deliveryState = await request.json(); return Response.json({status: 'completed'}); }
      return Response.json({}, {status: 404});
    },
  };
  const previousFetch = globalThis.fetch;
  let targetUrl = '';
  globalThis.fetch = async url => { targetUrl = String(url); return new Response('{}', {status: 200}); };
  try {
    assert.equal(await deliverPendingTask({TASK_QUEUE: {getByName: () => queue}, DELIVERY_TOKEN_KEY: key}, '00000000-0000-4000-8000-000000000002'), true);
    assert.match(targetUrl, /interaction-secret/);
    assert.deepEqual(deliveryState, {delivered: true, error: ''});
  } finally {
    globalThis.fetch = previousFetch;
  }
});
