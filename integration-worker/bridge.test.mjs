import test from 'node:test';
import assert from 'node:assert/strict';
import {completeTask} from './bridge.mjs';

test('bridge dispatches only the explicit local provider and route', async () => {
  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = {url: String(url), body: JSON.parse(options.body)};
    return Response.json({text: 'reviewed result', model: 'grok-test'});
  };
  try {
    const result = await completeTask({agents: {future: {provider: 'Grok', model: 'grok-test', systemPrompt: 'Be concise.'}}}, {
      id: 'task-1', agentId: 'future', intent: 'ask', prompt: 'Review this patch',
    });
    assert.equal(result, 'reviewed result');
    assert.equal(request.url, 'http://127.0.0.1:4173/api/integrations/chat');
    assert.equal(request.body.provider, 'Grok');
    assert.equal(request.body.model, 'grok-test');
    assert.equal(request.body.messages[0].content.includes('Be concise.'), true);
    assert.equal(request.body.messages[1].content, 'Review this patch');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('bridge fails visibly when a route or selected provider is unavailable', async () => {
  await assert.rejects(completeTask({agents: {}}, {agentId: 'unknown'}), /no local route/);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({error: 'Selected provider is offline'}, {status: 409});
  try {
    await assert.rejects(completeTask({agents: {future: {provider: 'Hermes'}}}, {agentId: 'future', intent: 'task', prompt: 'Do it'}), /Selected provider is offline/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
