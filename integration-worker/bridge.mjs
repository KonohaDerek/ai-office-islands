import {join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';

process.env.AI_OFFICE_SETTINGS_PATH ||= join(homedir(), 'Documents', 'Private', '09_AI', 'ai-office-islands', 'settings.yaml');
const {readIntegrationBridgeConfig} = await import('../server/integrations.mjs');

const POLL_MS = 2_000;
const RENEW_MS = 20_000;
const MAX_REPLY_CHARS = 8_000;
const localApi = process.env.AI_OFFICE_LOCAL_API || 'http://127.0.0.1:4173';

async function requestJson(url, token, body, timeoutMs = 15_000) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

export async function completeTask(config, task) {
  const route = config.agents[task.agentId];
  if (!route) throw new Error(`Agent ${task.agentId} has no local route.`);
  const messages = [];
  const instruction = [route.systemPrompt, `You are responding to an external ${task.intent} request. Do not claim to have changed files or services unless you actually did so through an available tool.`].filter(Boolean).join('\n\n');
  if (instruction) messages.push({role: 'system', content: instruction});
  messages.push({role: 'user', content: task.prompt});
  const payload = await requestJson(`${localApi}/api/integrations/chat`, '', {
    provider: route.provider,
    ...(route.model ? {model: route.model} : {}),
    ...(route.hermesProfileId ? {hermesProfileId: route.hermesProfileId} : {}),
    messages,
  }, 130_000);
  if (typeof payload.text !== 'string' || !payload.text.trim()) throw new Error('Selected provider returned no text.');
  return payload.text.slice(0, MAX_REPLY_CHARS);
}

async function processTask(config, task) {
  const url = config.workerUrl;
  const heartbeat = setInterval(() => {
    requestJson(`${url}/bridge/tasks/${task.id}/renew`, config.token, {leaseToken: task.leaseToken}).catch(() => {});
  }, RENEW_MS);
  try {
    const result = await completeTask(config, task);
    await requestJson(`${url}/bridge/tasks/${task.id}/complete`, config.token, {leaseToken: task.leaseToken, result});
  } catch (error) {
    const message = String(error?.message || 'Agent execution failed').slice(0, 400);
    await requestJson(`${url}/bridge/tasks/${task.id}/fail`, config.token, {leaseToken: task.leaseToken, error: message, retryable: false}).catch(() => {});
    process.stderr.write(`Task ${task.id} failed: ${message}\n`);
  } finally {
    clearInterval(heartbeat);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const config = await readIntegrationBridgeConfig();
  if (!config) throw new Error('External bridge is not configured. Run npm run bridge:configure first.');
  process.stdout.write(`AI Office bridge connected to ${config.workerUrl}; ${Object.keys(config.agents).length} Agent route(s).\n`);

  while (true) {
    try {
      const result = await requestJson(`${config.workerUrl}/bridge/claim`, config.token, {});
      if (result.task) await processTask(config, result.task);
      else await new Promise(resolve => setTimeout(resolve, POLL_MS));
    } catch (error) {
      process.stderr.write(`Bridge poll failed: ${String(error?.message || error).slice(0, 240)}\n`);
      await new Promise(resolve => setTimeout(resolve, Math.max(POLL_MS, 5_000)));
    }
  }
}
