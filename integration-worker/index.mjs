import {
  INTERACTION_DELIVERY_TTL_MS,
  MAX_BODY_BYTES,
  constantTimeEqual,
  jsonResponse,
  openDeliveryToken,
  parseAgentCommand,
  parseDiscordCommand,
  parseIdList,
  verifyDiscordRequest,
} from './core.mjs';
import {TaskQueue} from './queue.mjs';

function responseText(content, status = 200) {
  return new Response(content, {status, headers: {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'}});
}

function interactionResponse(content, ephemeral = true) {
  return jsonResponse({type: 4, data: {content, ...(ephemeral ? {flags: 64} : {})}});
}

function deferredInteractionResponse() {
  return jsonResponse({type: 5, data: {flags: 64}});
}

async function readBoundedBody(request) {
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new Error('Request body exceeds limit');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) throw new Error('Request body exceeds limit');
  return bytes;
}

async function parseJsonBody(bytes) {
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { return null; }
}

function queueStub(env) {
  if (!env.TASK_QUEUE || typeof env.TASK_QUEUE.getByName !== 'function') throw new Error('Task queue binding is not configured');
  return env.TASK_QUEUE.getByName(env.INSTALLATION_ID || 'default');
}

async function queueRequest(env, path, body, method = 'POST') {
  const request = new Request('https://task-queue.internal' + path, {
    method,
    ...(body === undefined ? {} : {headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}),
  });
  return queueStub(env).fetch(request);
}

function enabledAgent(env, agentId) {
  return parseIdList(env.ENABLED_AGENT_IDS).has(agentId);
}

async function sendTelegram(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  try {
    const response = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({chat_id: chatId, text: String(text || '').slice(0, 4000)}),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function discordEditOriginal(applicationId, token, text) {
  try {
    const response = await fetch('https://discord.com/api/v10/webhooks/' + encodeURIComponent(applicationId) + '/' + encodeURIComponent(token) + '/messages/@original', {
      method: 'PATCH',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({content: String(text || '').slice(0, 1900)}),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function updateDeliveryStatus(env, taskId, delivered, error = '') {
  await queueRequest(env, '/tasks/' + taskId + '/delivery-status', {delivered, error});
}

export async function deliverPendingTask(env, taskId) {
  const lookup = await queueRequest(env, '/tasks/' + taskId + '/delivery', undefined, 'GET');
  if (!lookup.ok) return false;
  const data = await lookup.json();
  const task = data.task;
  const delivery = data.delivery;
  const message = task.error
    ? '工作 ' + task.id + ' 未完成：' + task.error
    : '工作 ' + task.id + ' 已完成\n\n' + (task.result || 'Agent 沒有提供文字結果。');
  let delivered = false;
  if (delivery.source === 'telegram') {
    delivered = await sendTelegram(env, delivery.sourceId, message);
  } else if (delivery.source === 'discord' && delivery.sealedToken && delivery.applicationId && delivery.expiresAt > Date.now()) {
    try {
      const token = await openDeliveryToken(delivery.sealedToken, env.DELIVERY_TOKEN_KEY);
      delivered = await discordEditOriginal(delivery.applicationId, token, message);
    } catch {
      delivered = false;
    }
  }
  await updateDeliveryStatus(env, taskId, delivered, delivered ? '' : 'Source delivery failed or its response token expired.');
  return delivered;
}

async function acceptedTelegramTask(env, task) {
  const response = await queueRequest(env, '/tasks', {task});
  if (response.status === 429) return {error: '目前已達每小時請求上限，請稍後再試。', status: 429};
  if (!response.ok) return {error: '目前無法排入工作，請稍後再試。', status: 503};
  const result = await response.json();
  return {id: result.id, created: result.created};
}

async function telegramWebhook(request, env, ctx) {
  const providedSecret = request.headers.get('x-telegram-bot-api-secret-token') || '';
  if (!env.TELEGRAM_WEBHOOK_SECRET || !constantTimeEqual(providedSecret, env.TELEGRAM_WEBHOOK_SECRET)) return responseText('Unauthorized', 401);
  let bytes;
  try { bytes = await readBoundedBody(request); }
  catch { return responseText('Payload too large', 413); }
  const update = await parseJsonBody(bytes);
  if (!update || !Number.isSafeInteger(Number(update.update_id))) return responseText('Bad request', 400);
  const message = update.message || update.edited_message;
  if (!message?.text || !message.chat?.id || !message.from?.id) return responseText('OK');
  const sourceId = String(message.chat.id);
  if (!parseIdList(env.ALLOWED_TELEGRAM_CHAT_IDS).has(sourceId)) return responseText('OK');
  const parsed = parseAgentCommand(message.text);
  if (parsed.kind === 'none') return responseText('OK');
  if (parsed.kind === 'invalid') {
    ctx.waitUntil?.(sendTelegram(env, sourceId, parsed.error));
    return responseText('OK');
  }
  if (!enabledAgent(env, parsed.agentId)) {
    ctx.waitUntil?.(sendTelegram(env, sourceId, '這個 Agent 尚未啟用或不支援外部派工。'));
    return responseText('OK');
  }
  const task = {
    source: 'telegram',
    eventId: String(update.update_id),
    sourceId,
    userId: String(message.from.id),
    guildId: '',
    agentId: parsed.agentId,
    intent: parsed.intent,
    prompt: parsed.prompt,
  };
  const accepted = await acceptedTelegramTask(env, task);
  if (accepted.error) {
    ctx.waitUntil?.(sendTelegram(env, sourceId, accepted.error));
    return responseText('OK');
  }
  if (accepted.created) ctx.waitUntil?.(sendTelegram(env, sourceId, '已排入工作 ' + accepted.id + '，完成後會在這裡回覆。'));
  return responseText('OK');
}

function discordDenied() {
  return interactionResponse('此伺服器或使用者尚未獲授權使用 AI Office。');
}

async function discordWebhook(request, env) {
  if (!env.DISCORD_PUBLIC_KEY || !env.DELIVERY_TOKEN_KEY) return interactionResponse('Discord integration is not configured.');
  let bytes;
  try { bytes = await readBoundedBody(request); }
  catch { return responseText('Payload too large', 413); }
  const verified = await verifyDiscordRequest({
    signature: request.headers.get('x-signature-ed25519'),
    timestamp: request.headers.get('x-signature-timestamp'),
    body: bytes,
    publicKey: env.DISCORD_PUBLIC_KEY,
  });
  if (!verified) return responseText('Invalid signature', 401);
  const interaction = await parseJsonBody(bytes);
  if (!interaction) return responseText('Bad request', 400);
  if (interaction.type === 1) return jsonResponse({type: 1});
  const parsed = parseDiscordCommand(interaction);
  if (parsed.kind === 'none') return interactionResponse('Use /ai-office ask or /ai-office task.');
  if (parsed.kind === 'invalid') return interactionResponse(parsed.error);
  const guildId = String(interaction.guild_id || '');
  const userId = String(interaction.member?.user?.id || interaction.user?.id || '');
  if (!guildId || !userId || !parseIdList(env.ALLOWED_DISCORD_GUILD_IDS).has(guildId) || !parseIdList(env.ALLOWED_DISCORD_USER_IDS).has(userId)) return discordDenied();
  if (!enabledAgent(env, parsed.agentId)) return interactionResponse('This Agent is not enabled for external requests.');
  if (!interaction.id || !interaction.application_id || !interaction.token) return responseText('Bad request', 400);
  const createdAt = Date.now();
  const task = {
    source: 'discord',
    eventId: String(interaction.id),
    sourceId: String(interaction.channel_id || guildId),
    userId,
    guildId,
    agentId: parsed.agentId,
    intent: parsed.intent,
    prompt: parsed.prompt,
  };
  const response = await queueRequest(env, '/tasks', {
    task,
    delivery: {
      token: interaction.token,
      applicationId: String(interaction.application_id),
      expiresAt: createdAt + INTERACTION_DELIVERY_TTL_MS,
    },
  });
  if (response.status === 429) return interactionResponse('目前已達每小時請求上限，請稍後再試。');
  if (!response.ok) return interactionResponse('目前無法排入工作，請稍後再試。');
  return deferredInteractionResponse();
}

function bridgeAuthorized(request, env) {
  const authorization = request.headers.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return Boolean(env.BRIDGE_TOKEN && match && constantTimeEqual(match[1], env.BRIDGE_TOKEN));
}

async function bridgeRoutes(request, env) {
  if (!bridgeAuthorized(request, env)) return responseText('Unauthorized', 401);
  const url = new URL(request.url);
  if (request.method === 'POST' && url.pathname === '/bridge/claim') {
    const response = await queueRequest(env, '/claim', {});
    if (!response.ok) return jsonResponse({error: 'Unable to claim a task'}, 503);
    const result = await response.json();
    for (const taskId of result.expired || []) await deliverPendingTask(env, taskId);
    return jsonResponse(result);
  }
  const match = url.pathname.match(/^\/bridge\/tasks\/([0-9a-f-]{36})\/(renew|complete|fail)$/i);
  if (!match) return responseText('Not found', 404);
  if (request.method !== 'POST') return responseText('Method not allowed', 405);
  const [, taskId, action] = match;
  let bytes;
  try { bytes = await readBoundedBody(request); }
  catch { return responseText('Payload too large', 413); }
  const body = await parseJsonBody(bytes);
  if (!body) return responseText('Bad request', 400);
  const response = await queueRequest(env, '/tasks/' + taskId + '/' + action, body);
  if (!response.ok) return jsonResponse(await response.json().catch(() => ({error: 'Queue operation failed'})), response.status);
  const result = await response.json();
  if (action !== 'renew' && result.status === 'delivery_pending') await deliverPendingTask(env, taskId);
  return jsonResponse(result);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/webhooks/telegram') return await telegramWebhook(request, env, ctx);
      if (request.method === 'POST' && url.pathname === '/webhooks/discord') return await discordWebhook(request, env);
      if (url.pathname.startsWith('/bridge/')) return await bridgeRoutes(request, env);
      return responseText('Not found', 404);
    } catch {
      return jsonResponse({error: 'Integration request could not be completed'}, 500);
    }
  },
};

export {TaskQueue};
