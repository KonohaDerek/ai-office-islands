export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_PROMPT_CHARS = 12_000;
export const MAX_RESULT_CHARS = 8_000;
export const MAX_DISCORD_SKEW_SECONDS = 300;
export const TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const INTERACTION_DELIVERY_TTL_MS = 14 * 60 * 1000;
export const LEASE_MS = 60 * 1000;
export const MAX_ATTEMPTS = 3;
export const SOURCE_LIMIT_PER_HOUR = 30;
export const INSTALLATION_LIMIT_PER_HOUR = 100;

const encoder = new TextEncoder();

export function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers},
  });
}

export function parseIdList(value) {
  return new Set(String(value || '').split(',').map(item => item.trim()).filter(Boolean));
}

export function constantTimeEqual(left, right) {
  const a = encoder.encode(String(left || ''));
  const b = encoder.encode(String(right || ''));
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) difference |= (a[index] || 0) ^ (b[index] || 0);
  return difference === 0;
}

export function parseAgentCommand(text) {
  const trimmed = String(text || '').trim();
  const command = trimmed.match(/^\/(ask|task)(?:@[a-z0-9_]+)?(?:\s|$)/i);
  if (!command) return {kind: 'none'};
  const match = trimmed.match(/^\/(ask|task)(?:@[a-z0-9_]+)?\s+([a-z0-9][a-z0-9_-]{0,63})\s+([\s\S]+)$/i);
  if (!match) return {kind: 'invalid', error: '格式：/ask <agent-id> <prompt> 或 /task <agent-id> <prompt>'};
  const prompt = match[3].trim();
  if (!prompt) return {kind: 'invalid', error: '請輸入任務內容。'};
  if (prompt.length > MAX_PROMPT_CHARS) return {kind: 'invalid', error: '訊息太長，請縮短內容後重試。'};
  return {kind: 'task', intent: match[1].toLowerCase(), agentId: match[2].toLowerCase(), prompt};
}

function discordOption(options, name) {
  return Array.isArray(options) ? options.find(option => option?.name === name) : null;
}

export function parseDiscordCommand(interaction) {
  if (interaction?.type !== 2 || interaction?.data?.name !== 'ai-office') return {kind: 'none'};
  const subcommand = (interaction.data.options || []).find(option => option?.type === 1);
  const intent = subcommand?.name;
  if (!['ask', 'task'].includes(intent)) return {kind: 'invalid', error: '請使用 /ai-office ask 或 /ai-office task。'};
  const options = subcommand.options || [];
  const agentId = discordOption(options, 'agent')?.value;
  const promptValue = discordOption(options, 'prompt')?.value;
  if (typeof agentId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(agentId) || typeof promptValue !== 'string') {
    return {kind: 'invalid', error: '請指定有效 Agent 與 prompt。'};
  }
  const prompt = promptValue.trim();
  if (!prompt) return {kind: 'invalid', error: '請輸入任務內容。'};
  if (prompt.length > MAX_PROMPT_CHARS) return {kind: 'invalid', error: '訊息太長，請縮短內容後重試。'};
  return {kind: 'task', intent, agentId: agentId.toLowerCase(), prompt};
}

function decodeHex(value) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

export async function verifyDiscordRequest({signature, timestamp, body, publicKey, nowSeconds = Math.floor(Date.now() / 1000)}) {
  if (typeof signature !== 'string' || typeof timestamp !== 'string' || !/^\d{10,13}$/.test(timestamp)) return false;
  const timestampSeconds = timestamp.length > 10 ? Math.floor(Number(timestamp) / 1000) : Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > MAX_DISCORD_SKEW_SECONDS) return false;
  const signatureBytes = decodeHex(signature);
  const publicKeyBytes = decodeHex(String(publicKey || ''));
  if (!signatureBytes || signatureBytes.length !== 64 || !publicKeyBytes || publicKeyBytes.length !== 32) return false;
  try {
    const key = await crypto.subtle.importKey('raw', publicKeyBytes, {name: 'Ed25519'}, false, ['verify']);
    const message = new Uint8Array(encoder.encode(timestamp).length + body.byteLength);
    message.set(encoder.encode(timestamp));
    message.set(new Uint8Array(body), encoder.encode(timestamp).length);
    return await crypto.subtle.verify('Ed25519', key, signatureBytes, message);
  } catch {
    return false;
  }
}

export function encodeBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function decodeKey(value) {
  if (/^[0-9a-f]{64}$/i.test(String(value || ''))) return decodeHex(value);
  try {
    const decoded = decodeBase64(value);
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

export async function sealDeliveryToken(token, keyText) {
  const keyBytes = decodeKey(keyText);
  if (!keyBytes) throw new Error('DELIVERY_TOKEN_KEY must be a 32-byte hex or base64 secret.');
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, encoder.encode(token));
  return encodeBase64(new Uint8Array([...iv, ...new Uint8Array(ciphertext)]));
}

export async function openDeliveryToken(sealed, keyText) {
  const keyBytes = decodeKey(keyText);
  if (!keyBytes) throw new Error('DELIVERY_TOKEN_KEY must be a 32-byte hex or base64 secret.');
  const data = decodeBase64(sealed);
  if (data.length <= 12) throw new Error('Invalid encrypted delivery metadata.');
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({name: 'AES-GCM', iv: data.slice(0, 12)}, key, data.slice(12));
  return new TextDecoder().decode(plaintext);
}
