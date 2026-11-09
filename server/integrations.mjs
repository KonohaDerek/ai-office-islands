import {createCipheriv, createDecipheriv, randomBytes, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {access, chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {homedir, tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {clampQuotaPercent, finiteQuotaNumber} from './quota-values.mjs';

const connections = new Map();
const savedCredentials = new Map();
const hermesProfileCredentials = new Map();
let integrationBridgeConfig = null;
const moduleDir = dirname(fileURLToPath(import.meta.url));
const projectDir = dirname(moduleDir);
const settingsPath = process.env.AI_OFFICE_SETTINGS_PATH || join(homedir(), 'Documents', 'Private', '09_AI', 'ai-office-islands', 'settings.yaml');
const keychainHelperPath = join(moduleDir, 'keychain.swift');
const swiftModuleCachePath = '/private/tmp/ai-office-swift-module-cache';
const settingsAad = Buffer.from('ai-office-encrypted-settings-v1');
let settingsWriteQueue = Promise.resolve();
let cachedEncryptionKey;
let encryptionKeyPromise;
class UpstreamError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
const defaults = {
  Hermes: {baseUrl: process.env.HERMES_BASE_URL || 'http://127.0.0.1:8642/v1', apiKey: process.env.HERMES_API_KEY || ''},
  Grok: {baseUrl: process.env.GROK_BASE_URL || 'https://api.x.ai/v1', apiKey: process.env.XAI_API_KEY || ''},
  Claude: {baseUrl: process.env.CLAUDE_BASE_URL || 'https://api.anthropic.com/v1', apiKey: process.env.ANTHROPIC_API_KEY || ''},
  OpenAI: {baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY || ''},
};

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}

async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 64_000) throw new Error('請求內容太大。');
  }
  try { return JSON.parse(text || '{}'); } catch { throw new Error('連線資料格式錯誤。'); }
}

function normalizeBaseUrl(value, provider) {
  const parsed = new URL(value || defaults[provider]?.baseUrl || defaults.Grok.baseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('網址必須使用 HTTP 或 HTTPS。');
  if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(parsed.hostname)) {
    throw new Error('非本機網址請使用 HTTPS。');
  }
  parsed.search = '';
  parsed.hash = '';
  let path = parsed.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/v1')) path = `${path}/v1`;
  return `${parsed.origin}${path}`;
}

async function requestJson(url, apiKey, options = {}, timeoutMs = 18_000) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...options.headers},
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data?.error?.message === 'string' ? data.error.message : `來源回傳 HTTP ${response.status}`;
    throw new UpstreamError(message.slice(0, 280), response.status);
  }
  return data;
}

async function requestClaudeJson(url, apiKey, options = {}, timeoutMs = 18_000) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {'x-api-key': apiKey, 'anthropic-version': '2026-10-21', 'Content-Type': 'application/json', ...options.headers},
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data?.error?.message === 'string' ? data.error.message : `Claude API 回傳 HTTP ${response.status}`;
    throw new UpstreamError(message.slice(0, 280), response.status);
  }
  return data;
}

function requestProviderJson(provider, url, apiKey, options, timeoutMs) {
  return provider === 'Claude'
    ? requestClaudeJson(url, apiKey, options, timeoutMs)
    : requestJson(url, apiKey, options, timeoutMs);
}

function fallbackModel(provider) {
  return provider === 'Hermes' ? 'hermes-agent' : provider === 'Grok' ? 'grok-3-mini-latest' : provider === 'Claude' ? 'claude-sonnet-5-5' : 'gpt-5';
}

function executableCandidates(command) {
  const searchPath = (process.env.PATH || '').split(':').filter(Boolean);
  const extra = [join(process.env.HOME || homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  return [...new Set([...searchPath, ...extra].map(directory => join(directory, command)))];
}

async function findExecutable(command) {
  for (const candidate of executableCandidates(command)) {
    try { await access(candidate, 1); return candidate; } catch {}
  }
  return '';
}

function runLocalCommand(executable, args, {input = '', timeoutMs = 15_000, maxOutput = 2 * 1024 * 1024} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {cwd: tmpdir(), env: {...process.env, NO_COLOR: '1', CI: '1'}, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(new Error('本機 CLI 連線逾時。')); }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout = (stdout + chunk).slice(-maxOutput); });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-maxOutput); });
    child.on('error', error => finish(new Error(`無法啟動本機 CLI：${error.message}`)));
    child.on('close', code => code === 0
      ? finish(null, {stdout, stderr})
      : finish(new Error((stderr || stdout || `本機 CLI 結束代碼 ${code}`).trim().slice(-500))));
    child.stdin.end(input);
  });
}

async function inspectCliAuth(provider) {
  const command = provider === 'CodexOAuth' ? 'codex' : 'claude';
  const executable = await findExecutable(command);
  if (!executable) return {available: false, loggedIn: false, detail: `${command} CLI 未安裝或不在 PATH。`};
  try {
    const result = provider === 'CodexOAuth'
      ? await runLocalCommand(executable, ['login', 'status'])
      : await runLocalCommand(executable, ['auth', 'status', '--json']);
    if (provider === 'CodexOAuth') {
      const chatgptLogin = /logged in using chatgpt/i.test(result.stdout + result.stderr);
      const apiKeyLogin = /logged in using api key/i.test(result.stdout + result.stderr);
      return {available: true, loggedIn: chatgptLogin, authMethod: apiKeyLogin ? 'API Key' : chatgptLogin ? 'ChatGPT OAuth' : 'none', detail: chatgptLogin ? '已使用 ChatGPT 登入 Codex CLI' : apiKeyLogin ? 'Codex CLI 目前使用 API Key；請改用 ChatGPT OAuth 登入' : 'Codex CLI 尚未登入'};
    }
    const status = JSON.parse(result.stdout || '{}');
    const authMethod = String(status.authMethod || '');
    const loggedIn = Boolean(status.loggedIn) && !/api.?key/i.test(authMethod);
    return {available: true, loggedIn, authMethod, detail: loggedIn ? `Claude CLI 已登入 · ${authMethod || 'OAuth'}` : status.loggedIn ? 'Claude CLI 目前由 API Key 認證；請切換 API Key 模式或改用 OAuth 登入' : 'Claude CLI 尚未登入'};
  } catch (error) {
    if (provider === 'ClaudeOAuth') {
      const raw = error?.message || '';
      const firstBrace = raw.indexOf('{');
      const lastBrace = raw.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        try {
          const status = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
          const authMethod = String(status.authMethod || '');
          const loggedIn = Boolean(status.loggedIn) && !/api.?key/i.test(authMethod);
          return {available: true, loggedIn, authMethod, detail: loggedIn ? `Claude CLI 已登入 · ${authMethod || 'OAuth'}` : status.loggedIn ? 'Claude CLI 目前由 API Key 認證；請改用 API Key 模式或改用 OAuth 登入' : 'Claude CLI 尚未登入'};
        } catch {}
      }
    }
    return {available: true, loggedIn: false, detail: error.message.slice(0, 180)};
  }
}

async function readCodexQuota() {
  const executable = await findExecutable('codex');
  if (!executable) return {available: false, reason: '找不到 Codex CLI。'};
  const auth = await inspectCliAuth('CodexOAuth');
  if (!auth.loggedIn) return {available: false, reason: auth.detail || 'Codex CLI 尚未使用 ChatGPT 登入。'};

  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
      cwd: tmpdir(),
      env: {...process.env, NO_COLOR: '1', CI: '1'},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      error ? reject(error) : resolve(result);
    };
    const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
    const timer = setTimeout(() => finish(new Error('讀取 Codex 額度逾時。')), 12_000);
    child.stdout.setEncoding('utf8').on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return finish(new Error('Codex CLI 額度介面初始化失敗。'));
          send({method: 'initialized', params: {}});
          send({method: 'account/rateLimits/read', id: 2, params: {}});
        } else if (message.id === 2) {
          if (message.error) return finish(new Error(message.error.message || 'Codex CLI 無法讀取帳戶額度。'));
          const result = message.result || {};
          const limits = result.rateLimitsByLimitId?.codex || result.rateLimits || {};
          const windowData = (key, label) => {
            const item = limits[key];
            const used = finiteQuotaNumber(item?.usedPercent);
            if (used === null) return null;
            const usedPercent = clampQuotaPercent(used);
            const reset = Number(item.resetsAt);
            return {
              label,
              usedPercent,
              remainingPercent: Math.max(0, 100 - usedPercent),
              windowDurationMins: Number(item.windowDurationMins) || null,
              resetsAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null,
            };
          };
          finish(null, {
            available: true,
            planType: limits.planType || null,
            observedAt: new Date().toISOString(),
            windows: [windowData('primary', '主要額度'), windowData('secondary', '週額度')].filter(Boolean),
            spendLimit: limits.individualLimit ? {
              limit: String(limits.individualLimit.limit || ''),
              used: String(limits.individualLimit.used || ''),
              remainingPercent: clampQuotaPercent(limits.individualLimit.remainingPercent),
              resetsAt: Number.isFinite(Number(limits.individualLimit.resetsAt)) && Number(limits.individualLimit.resetsAt) > 0
                ? new Date(Number(limits.individualLimit.resetsAt) * 1000).toISOString()
                : null,
            } : null,
            credits: limits.credits ? {
              hasCredits: Boolean(limits.credits.hasCredits),
              unlimited: Boolean(limits.credits.unlimited),
              balance: typeof limits.credits.balance === 'string' ? limits.credits.balance : null,
            } : null,
          });
        }
      }
    });
    child.on('error', error => finish(new Error(`無法啟動 Codex 額度讀取：${error.message}`)));
    child.on('close', code => {
      if (!settled) finish(new Error(code === 0 ? 'Codex 額度讀取程序提前結束。' : 'Codex CLI 額度讀取失敗。'));
    });
    send({method: 'initialize', id: 1, params: {clientInfo: {name: 'ai-office-islands', title: 'AI Office Islands', version: '0.0.0'}}});
  });
}

async function readClaudeOAuthQuota() {
  const credentialsPath = join(process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || homedir(), '.claude'), '.credentials.json');
  let credentials;
  try { credentials = JSON.parse(await readFile(credentialsPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {available: false, reason: 'Claude CLI 憑證由系統 Keychain 管理，或找不到本機 OAuth 憑證檔；請從 Claude 帳戶頁查看。'};
    return {available: false, reason: '無法讀取 Claude CLI OAuth 狀態。'};
  }
  const oauth = credentials.claudeAiOauth || credentials;
  const accessToken = oauth.accessToken || oauth.access_token;
  if (typeof accessToken !== 'string' || !accessToken) return {available: false, reason: 'Claude CLI 憑證沒有可讀取的 OAuth 權杖；請從 Claude 帳戶頁查看。'};

  const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
    signal: AbortSignal.timeout(12_000),
    headers: {Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json'},
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = response.status === 429 ? 'Claude 用量查詢目前被限流，請稍後再試或直接開啟 Claude 帳戶頁。' : response.status === 401 ? 'Claude CLI OAuth 已過期，請重新登入 Claude CLI。' : `Claude 用量查詢失敗（HTTP ${response.status}）。`;
    return {available: false, reason: detail};
  }
  const windows = [];
  const rows = Array.isArray(data.limits) ? data.limits : [];
  const usageItems = [
    [data.five_hour || rows.find(item => item.kind === 'session' || item.group === 'session'), '5 小時額度'],
    [data.seven_day || rows.find(item => item.kind === 'weekly_all' || (item.group === 'weekly' && !item.scope)), '每週額度'],
    [data.seven_day_sonnet || rows.find(item => item.kind === 'weekly_scoped' && /sonnet/i.test(item.scope?.model?.display_name || item.scope?.model?.id || '')), 'Sonnet 每週額度'],
    [data.seven_day_opus || rows.find(item => item.kind === 'weekly_scoped' && /opus/i.test(item.scope?.model?.display_name || item.scope?.model?.id || '')), 'Opus 每週額度'],
  ];
  for (const [item, label] of usageItems) {
    const usage = Number(item?.utilization ?? item?.percent);
    if (!item || !Number.isFinite(usage)) continue;
    const usedPercent = Math.max(0, Math.min(100, usage));
    const resetValue = item.resets_at || item.resetsAt || null;
    const resetDate = resetValue ? new Date(typeof resetValue === 'number' && resetValue < 1_000_000_000_000 ? resetValue * 1000 : resetValue) : null;
    windows.push({label, usedPercent, remainingPercent: Math.max(0, 100 - usedPercent), resetsAt: resetDate && !Number.isNaN(resetDate.valueOf()) ? resetDate.toISOString() : null});
  }
  return {available: windows.length > 0, windows, observedAt: new Date().toISOString(), reason: windows.length ? '' : 'Claude OAuth 沒有回報可用額度視窗。'};
}

const quotaProviderInfo = {
  Hermes: {label: 'Hermes Agent API', reason: 'Hermes 可代理不同上游模型或本機模型，沒有通用的剩餘額度與重置 API。請查看 Hermes 設定的上游供應商。'},
  Grok: {label: 'Grok API', url: 'https://console.x.ai/team/usage', reason: '一般 xAI API Key 無法查詢帳戶剩餘額度。xAI 的預付餘額與月支出上限需透過 Management API 讀取；AI Office 目前尚未接入 Management Key 與 Team ID，因此此處不會推估額度或重置時間。'},
  Claude: {label: 'Claude API', url: 'https://platform.claude.com/usage', reason: '目前連線使用 API Key；一般 API Key 無法讀取帳戶剩餘額度。組織用量報表需另外授權的管理憑證。'},
  OpenAI: {label: 'OpenAI API', url: 'https://platform.openai.com/usage', reason: '目前連線使用 API Key；API 用量與帳戶預付餘額不會由一般 API Key 回報。'},
  ClaudeOAuth: {label: 'Claude Code OAuth', url: 'https://claude.ai/settings/usage', reason: 'Claude Code 的方案用量可在 Claude 帳戶頁查看。'},
};

async function readQuotaOverview() {
  const cli = await Promise.all([inspectCliAuth('ClaudeOAuth'), inspectCliAuth('CodexOAuth')]);
  const sources = [];
  for (const provider of ['Hermes', 'Grok', 'Claude', 'OpenAI']) {
    const live = connections.get(provider);
    const saved = savedCredentials.get(provider);
    if (!live && !saved) continue;
    const info = quotaProviderInfo[provider];
    sources.push({id: provider, label: info.label, connected: Boolean(live), model: live?.model || saved?.model || '', supported: false, url: info.url || null, reason: info.reason});
  }
  if (cli[0].loggedIn || connections.has('ClaudeOAuth')) {
    const info = quotaProviderInfo.ClaudeOAuth;
    let quota;
    try { quota = await readClaudeOAuthQuota(); }
    catch (error) { quota = {available: false, reason: error.message || info.reason}; }
    sources.push({id: 'ClaudeOAuth', label: info.label, connected: connections.has('ClaudeOAuth'), model: 'Claude Code', supported: true, quota, url: info.url, reason: quota.available ? '' : quota.reason || info.reason});
  }
  if (cli[1].loggedIn || connections.has('CodexOAuth')) {
    let quota;
    try { quota = await readCodexQuota(); }
    catch (error) { quota = {available: false, reason: error.message}; }
    sources.push({id: 'CodexOAuth', label: 'Codex CLI OAuth', connected: connections.has('CodexOAuth'), model: quota.planType || 'ChatGPT 方案', supported: true, quota, url: 'https://chatgpt.com/settings/usage', reason: quota.available ? '' : quota.reason || '目前讀不到 Codex 帳戶額度。'});
  }
  return {sources, observedAt: new Date().toISOString()};
}

async function chatWithLocalCli(provider, messages) {
  const command = provider === 'CodexOAuth' ? 'codex' : 'claude';
  const executable = await findExecutable(command);
  if (!executable) throw new Error(`${command} CLI 未安裝或不在 PATH。`);
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
  const transcript = messages.filter(message => message.role !== 'system').map(message => `${message.role === 'user' ? '使用者' : '助理'}：\n${message.content}`).join('\n\n');
  const prompt = `請直接回答以下對話的最新問題。只回覆文字，不要使用工具、讀取或修改本機檔案。\n\n${system ? `角色與系統指示：\n${system}\n\n` : ''}對話紀錄：\n${transcript}`;
  if (provider === 'ClaudeOAuth') {
    const result = await runLocalCommand(executable, ['--print', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--tools', '', '--system-prompt', '你是 AI Office 中的對話角色。只根據提供的對話作答，不呼叫工具、不讀取或修改任何本機檔案。', prompt], {timeoutMs: 120_000});
    let data;
    try { data = JSON.parse(result.stdout); } catch { data = null; }
    const text = typeof data?.result === 'string' ? data.result : result.stdout.trim();
    return {text, model: data?.model || 'Claude CLI OAuth'};
  }
  const cliTempDir = tmpdir();
  const outputPath = join(cliTempDir, `ai-office-codex-${randomUUID()}.txt`);
  try {
    await runLocalCommand(executable, ['exec', '--json', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '--cd', cliTempDir, '--output-last-message', outputPath, '-'], {input: prompt, timeoutMs: 120_000});
    const text = (await readFile(outputPath, 'utf8')).trim();
    if (!text) throw new Error('Codex CLI 沒有回傳文字內容。');
    return {text, model: 'Codex CLI OAuth'};
  } finally { await unlink(outputPath).catch(() => {}); }
}

function yamlScalar(value) {
  const text = String(value || '').trim();
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replace(/\\"/g, '"');
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

async function readHermesBotRoster() {
  const hermesHome = process.env.HERMES_HOME || join(process.env.HOME || '', '.hermes');
  const profilesPath = join(hermesHome, 'profiles');
  let entries;
  try { entries = await readdir(profilesPath, {withFileTypes: true}); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const bots = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let profile;
    try { profile = await readFile(join(profilesPath, entry.name, 'profile.yaml'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const block = profile.match(/^  hermes-bots:\s*\r?\n((?:^    [^\r\n]*(?:\r?\n|$))*)/m)?.[1];
    if (!block) continue;
    const read = key => yamlScalar(block.match(new RegExp(`^    ${key}:\\s*(.*?)\\s*$`, 'm'))?.[1]);
    const title = read('title');
    if (!title) continue;
    const profileApiKey = hermesProfileCredentials.get(entry.name)?.apiKey || await readHermesProfileApiKey(entry.name);
    bots.push({
      id: `hermes-bot-${entry.name}`,
      hermesProfileId: entry.name,
      name: title.slice(0, 80),
      role: 'Hermes Bot Mode profile',
      source: 'HermesBot',
      avatar: 'character-engineer.png',
      hue: 115,
      status: '待命中',
      x: 35 + (bots.length % 5) * 7,
      y: 38 + (bots.length % 4) * 8,
      zone: 'main',
      botSource: read('source'),
      imageKind: read('imageKind'),
      shape: read('shape'),
      apiServerConfigured: Boolean(profileApiKey),
    });
  }
  return bots.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
}

function hermesHomePath() {
  return process.env.HERMES_HOME || join(process.env.HOME || '', '.hermes');
}

function parseEnvValue(source, name) {
  const value = source.match(new RegExp(`^${name}\\s*=\\s*(.*?)\\s*$`, 'm'))?.[1] || '';
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1).replace(/\\"/g, '"');
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

async function readHermesProfileApiKey(profileId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(profileId)) return '';
  try {
    const source = await readFile(join(hermesHomePath(), 'profiles', profileId, '.env'), 'utf8');
    return parseEnvValue(source, 'API_SERVER_KEY');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function writeHermesProfileApiKey(profileId, apiKey) {
  const filePath = join(hermesHomePath(), 'profiles', profileId, '.env');
  let previous = '';
  let existed = true;
  try { previous = await readFile(filePath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; existed = false; }
  const next = /^API_SERVER_KEY\s*=/m.test(previous)
    ? previous.replace(/^API_SERVER_KEY\s*=.*$/m, `API_SERVER_KEY=${apiKey}`)
    : `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}# AI Office profile API connection\nAPI_SERVER_KEY=${apiKey}\n`;
  await mkdir(dirname(filePath), {recursive: true});
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, next, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  return {previous, existed};
}

async function restoreHermesProfileEnv(profileId, snapshot) {
  const filePath = join(hermesHomePath(), 'profiles', profileId, '.env');
  if (snapshot?.existed) await writeFile(filePath, snapshot.previous, {encoding: 'utf8', mode: 0o600});
  else await unlink(filePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => typeof part?.text === 'string' ? part.text : '').join('').trim();
}

async function listCodexSessionFiles(root, depth = 0) {
  if (depth > 7) return [];
  let entries;
  try { entries = await readdir(root, {withFileTypes: true}); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listCodexSessionFiles(path, depth + 1));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const details = await stat(path);
        if (details.size <= 32 * 1024 * 1024) files.push({path, modifiedAt: details.mtime.toISOString(), modifiedMs: details.mtimeMs, size: details.size});
      } catch {}
    }
  }
  return files;
}

async function readCodexSession(file, includeMessages = false) {
  const maxBytes = includeMessages ? 16 * 1024 * 1024 : 256 * 1024;
  if (includeMessages && file.size > maxBytes) throw new Error('Codex 工作階段檔案超過匯入上限。');
  const handle = await open(file.path, 'r');
  const buffer = Buffer.alloc(Math.min(file.size, maxBytes));
  let source;
  try {
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    source = buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
  let meta = {};
  const messages = [];
  let ordinal = 0;
  for (const line of source.split(/\r?\n/)) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const payload = record?.payload;
    if (record?.type === 'session_meta' && payload && typeof payload === 'object') meta = payload;
    if (record?.type !== 'response_item' || payload?.type !== 'message') continue;
    const role = payload.role;
    if (!['user', 'assistant'].includes(role) || payload.phase === 'analysis') continue;
    const text = textContent(payload.content).slice(0, 8000);
    if (!text) continue;
    if (includeMessages || (role === 'user' && !messages.some(message => message.role === 'user')) || role === 'assistant') {
      messages.push({role, text, timestamp: record.timestamp || '', ordinal: ordinal++});
    }
  }
  const id = String(meta.id || meta.session_id || basename(file.path, '.jsonl')).slice(0, 200);
  const firstUser = messages.find(message => message.role === 'user');
  const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant');
  const title = String(firstUser?.text || meta.agent_nickname || `Codex CLI 對話 ${id.slice(0, 8)}`).replace(/\s+/g, ' ').trim().slice(0, 100);
  return {
    id,
    title,
    preview: String(lastAssistant?.text || firstUser?.text || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    lastActive: file.modifiedAt,
    messageCount: messages.length,
    source: String(meta.thread_source || meta.source || 'Codex CLI').slice(0, 40),
    parentThreadId: typeof meta.parent_thread_id === 'string' ? meta.parent_thread_id : '',
    agentNickname: String(meta.agent_nickname || '').slice(0, 80),
    agentPath: String(meta.agent_path || '').slice(0, 120),
    cwd: String(meta.cwd || '').slice(0, 240),
    messages,
    modifiedMs: file.modifiedMs,
    filePath: file.path,
    size: file.size,
  };
}

function readTomlString(source, key) {
  const triple = source.match(new RegExp(`^\\s*${key}\\s*=\\s*(?:"""([\\s\\S]*?)"""|'{3}([\\s\\S]*?)'{3})`, 'm'));
  if (triple) return String(triple[1] ?? triple[2] ?? '').trim();
  const line = source.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm'))?.[1];
  if (!line) return '';
  const value = line.trim();
  if (value.startsWith('"')) {
    try { return JSON.parse(value.slice(0, value.lastIndexOf('"') + 1)); } catch { return value.slice(1, value.lastIndexOf('"')); }
  }
  if (value.startsWith("'")) return value.slice(1, value.lastIndexOf("'"));
  return value.split(/\s+#/, 1)[0].trim();
}

async function readCodexAgentRoster() {
  const codexHome = process.env.CODEX_HOME || join(process.env.HOME || homedir(), '.codex');
  const codexHomes = [...new Set([process.env.CODEX_IMPORT_HOME, codexHome].filter(Boolean))];
  const builtins = [
    {name: 'default', description: '通用任務協作；處理 Codex 沒有指定其他角色的工作。', scope: 'Codex 內建'},
    {name: 'worker', description: '執行程式碼實作與修正。', scope: 'Codex 內建'},
    {name: 'explorer', description: '唯讀探索程式碼、查找資訊並彙整證據。', scope: 'Codex 內建'},
  ];
  const byName = new Map(builtins.map(agent => [agent.name.toLowerCase(), agent]));
  const directories = [
    ...codexHomes.map(home => ({path: join(home, 'agents'), scope: home === process.env.CODEX_IMPORT_HOME ? '匯入來源' : '個人設定'})),
    {path: join(projectDir, '.codex', 'agents'), scope: '目前專案'},
  ];
  for (const {path, scope} of directories) {
    let entries;
    try { entries = await readdir(path, {withFileTypes: true}); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.toml')) continue;
      try {
        const fullPath = join(path, entry.name);
        const details = await stat(fullPath);
        if (details.size > 256 * 1024) continue;
        const contents = await readFile(fullPath, 'utf8');
        const name = readTomlString(contents, 'name').slice(0, 80);
        const description = readTomlString(contents, 'description').slice(0, 240);
        if (!name || !description) continue;
        byName.set(name.toLowerCase(), {
          name,
          description,
          scope,
          model: readTomlString(contents, 'model').slice(0, 80),
          developerInstructions: readTomlString(contents, 'developer_instructions').slice(0, 4000),
        });
      } catch {}
    }
  }
  return [...byName.values()].map(agent => ({
    id: `codex-role-${Buffer.from(agent.name).toString('hex').slice(0, 48)}`,
    ...agent,
  }));
}

async function readCodexThreads() {
  const codexHome = process.env.CODEX_HOME || join(process.env.HOME || homedir(), '.codex');
  const codexHomes = [...new Set([process.env.CODEX_IMPORT_HOME, codexHome].filter(Boolean))];
  const fileMap = new Map();
  for (const home of codexHomes) {
    for (const file of await listCodexSessionFiles(join(home, 'sessions'))) fileMap.set(file.path, file);
  }
  const files = [...fileMap.values()].sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, 200);
  const threads = [];
  for (const file of files) {
    try { threads.push(await readCodexSession(file, false)); } catch {}
  }
  const byId = new Map(threads.map(thread => [thread.id, thread]));
  for (const thread of threads) thread.subagents = [];
  for (const thread of threads) {
    const parent = byId.get(thread.parentThreadId);
    if (parent) parent.subagents.push(thread);
  }
  return threads.filter(thread => !thread.parentThreadId && !['subagent', 'guardian_review'].includes(thread.source)).sort((a, b) => b.modifiedMs - a.modifiedMs);
}

function flattenCodexThreads(threads, parentTitle = '') {
  const flattened = [];
  const visit = (thread, parentTitle = '') => {
    flattened.push({...thread, parentTitle});
    for (const child of thread.subagents || []) visit(child, thread.title);
  };
  for (const thread of threads) visit(thread, parentTitle);
  return flattened;
}

function encryptionKey() {
  if (process.env.AI_OFFICE_ENCRYPTION_KEY) {
    const content = process.env.AI_OFFICE_ENCRYPTION_KEY.trim();
    const key = /^[a-f0-9]{64}$/i.test(content) ? Buffer.from(content, 'hex') : Buffer.from(content, 'base64');
    if (key.length !== 32) throw new Error('AI_OFFICE_ENCRYPTION_KEY 必須包含 32-byte hex 或 base64 金鑰。');
    cachedEncryptionKey = key;
    return Promise.resolve(key);
  }
  if (process.env.AI_OFFICE_ENCRYPTION_KEY_FILE) {
    if (cachedEncryptionKey) return Promise.resolve(cachedEncryptionKey);
    if (encryptionKeyPromise) return encryptionKeyPromise;
    encryptionKeyPromise = readFile(process.env.AI_OFFICE_ENCRYPTION_KEY_FILE, 'utf8').then(value => {
      const content = value.trim();
      const key = /^[a-f0-9]{64}$/i.test(content) ? Buffer.from(content, 'hex') : Buffer.from(content, 'base64');
      if (key.length !== 32) throw new Error('AI_OFFICE_ENCRYPTION_KEY_FILE 必須包含 32-byte hex 或 base64 金鑰。');
      cachedEncryptionKey = key;
      return key;
    }).catch(error => {
      encryptionKeyPromise = undefined;
      throw error;
    });
    return encryptionKeyPromise;
  }
  if (process.platform !== 'darwin') throw new Error('加密保存需要 macOS Keychain。');
  if (cachedEncryptionKey) return Promise.resolve(cachedEncryptionKey);
  if (encryptionKeyPromise) return encryptionKeyPromise;
  encryptionKeyPromise = new Promise((resolve, reject) => {
    mkdir(swiftModuleCachePath, {recursive: true}).then(() => {
      const helper = spawn('/usr/bin/swift', ['-module-cache-path', swiftModuleCachePath, keychainHelperPath], {stdio: ['ignore', 'pipe', 'ignore']});
      let output = '';
      helper.stdout.setEncoding('utf8');
      helper.stdout.on('data', chunk => { output += chunk; });
      helper.on('error', () => reject(new Error('無法啟動 macOS Keychain 助手。')));
      helper.on('close', code => {
        const key = Buffer.from(output.trim(), 'base64');
        if (code !== 0 || key.length !== 32) return reject(new Error('無法從 macOS Keychain 取得加密金鑰。'));
        cachedEncryptionKey = key;
        resolve(key);
      });
    }).catch(() => reject(new Error('無法建立加密助手的暫存資料夾。')));
  }).catch(error => {
    encryptionKeyPromise = undefined;
    throw error;
  });
  return encryptionKeyPromise;
}

function yamlField(source, name) {
  return source.match(new RegExp(`^${name}: "([A-Za-z0-9+/=]+)"$`, 'm'))?.[1] || '';
}

async function readEncryptedSettings() {
  let source;
  try { source = await readFile(settingsPath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (!source.startsWith('format: ai-office-encrypted-settings-v1\nalgorithm: AES-256-GCM\n')) {
    throw new Error('settings.yaml 格式不受支援。');
  }
  const iv = Buffer.from(yamlField(source, 'iv'), 'base64');
  const authTag = Buffer.from(yamlField(source, 'auth_tag'), 'base64');
  const ciphertext = Buffer.from(yamlField(source, 'ciphertext'), 'base64');
  if (iv.length !== 12 || authTag.length !== 16 || !ciphertext.length) throw new Error('settings.yaml 加密資料不完整。');
  const decipher = createDecipheriv('aes-256-gcm', await encryptionKey(), iv);
  decipher.setAAD(settingsAad);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  const data = JSON.parse(plaintext);
  return data?.version === 1 && data.providers && typeof data.providers === 'object' ? data : {};
}

async function writeEncryptedSettings() {
  const write = settingsWriteQueue.then(async () => {
    const providers = Object.fromEntries([...savedCredentials].map(([provider, connection]) => [provider, {
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      model: connection.model,
    }]));
    const hermesProfiles = Object.fromEntries([...hermesProfileCredentials].map(([profileId, credential]) => [profileId, {
      apiKey: credential.apiKey,
      model: credential.model || '',
    }]));
    if (!Object.keys(providers).length && !Object.keys(hermesProfiles).length && !integrationBridgeConfig) {
      await unlink(settingsPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      return;
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', await encryptionKey(), iv);
    cipher.setAAD(settingsAad);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({version: 1, providers, hermesProfiles, integrationBridge: integrationBridgeConfig}), 'utf8'), cipher.final()]);
    const yaml = [
      'format: ai-office-encrypted-settings-v1',
      'algorithm: AES-256-GCM',
      `iv: "${iv.toString('base64')}"`,
      `auth_tag: "${cipher.getAuthTag().toString('base64')}"`,
      `ciphertext: "${ciphertext.toString('base64')}"`,
      '',
    ].join('\n');
    const temporaryPath = `${settingsPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temporaryPath, yaml, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, settingsPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
  });
  settingsWriteQueue = write.catch(() => {});
  return write;
}

async function rememberConnection(provider, connection) {
  const previous = savedCredentials.get(provider);
  savedCredentials.set(provider, {baseUrl: connection.baseUrl, apiKey: connection.apiKey, model: connection.model});
  try {
    await writeEncryptedSettings();
    connection.persisted = true;
    return true;
  } catch {
    if (previous) savedCredentials.set(provider, previous);
    else savedCredentials.delete(provider);
    connection.persisted = false;
    console.warn(`[AI Office] Could not save encrypted settings for ${provider}.`);
    return false;
  }
}

function publicState() {
  return Object.fromEntries(['Hermes', 'Grok', 'Claude', 'OpenAI', 'ClaudeOAuth', 'CodexOAuth'].map(provider => {
    const item = connections.get(provider);
    const saved = savedCredentials.get(provider);
    return [provider, item ? {
      connected: true,
      saved: Boolean(saved && saved.baseUrl === item.baseUrl && saved.apiKey === item.apiKey),
      baseUrl: item.baseUrl,
      model: item.model,
      models: item.models,
      connectedAt: item.connectedAt,
    } : {
      connected: false,
      saved: Boolean(saved),
      baseUrl: saved?.baseUrl || defaults[provider]?.baseUrl || '',
      model: saved?.model || '',
      models: [],
    }];
  }));
}

function sendError(res, error) {
  const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
  const message = timedOut
    ? error?.message?.startsWith('Hermes 兩分鐘內') ? error.message : '連線逾時，請確認服務已啟動並可從這台電腦連線。'
    : error?.message || '連線失敗。';
  json(res, timedOut ? 504 : error instanceof UpstreamError ? 502 : 400, {error: message.slice(0, 300)});
}

function hermesApiRoot(connection) {
  return connection.baseUrl.replace(/\/v1\/?$/, '');
}

function listFrom(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload[key])) return payload[key];
  for (const candidate of [payload.data, payload.items, payload.results]) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === 'object' && Array.isArray(candidate[key])) return candidate[key];
  }
  return [];
}

function normalizeHermesSession(session) {
  const id = session?.id ?? session?.session_id ?? session?.sessionId ?? session?.session_key;
  if (id === undefined || id === null || String(id).length > 300) return null;
  const title = session.title || session.display_name || session.name || session.preview || `Hermes 工作階段 ${String(id).slice(0, 8)}`;
  const sourceValue = session.source || session.platform || 'Hermes';
  return {
    id: String(id),
    title: String(title).slice(0, 100),
    source: typeof sourceValue === 'string' ? sourceValue.slice(0, 50) : 'Hermes',
    preview: String(session.preview || session.last_message || '').slice(0, 180),
    lastActive: String(session.last_active || session.updated_at || session.started_at || session.created_at || ''),
    messageCount: Number.isFinite(Number(session.message_count)) ? Number(session.message_count) : 0,
  };
}

function normalizeHermesMessages(payload) {
  const rows = listFrom(payload, 'messages');
  return rows.map(message => {
    const rawRole = String(message?.role || message?.sender || '').toLowerCase();
    const role = ['user', 'human'].includes(rawRole) ? 'user' : ['assistant', 'bot'].includes(rawRole) ? 'assistant' : '';
    const rawContent = message?.content ?? message?.text ?? message?.message ?? message?.body;
    const content = typeof rawContent === 'string' ? rawContent : Array.isArray(rawContent)
      ? rawContent.map(part => typeof part?.text === 'string' ? part.text : '').join('') : '';
    if (!role || !content.trim()) return null;
    const rawTime = message?.timestamp || message?.created_at || message?.createdAt || message?.time;
    const parsedTime = rawTime ? new Date(rawTime) : null;
    const time = parsedTime && !Number.isNaN(parsedTime.valueOf())
      ? parsedTime.toLocaleTimeString('zh-TW', {hour: '2-digit', minute: '2-digit', hour12: false})
      : typeof rawTime === 'string' ? rawTime.slice(0, 20) : '';
    return {role, text: content.slice(0, 12_000), time};
  }).filter(Boolean).slice(-80);
}

export function integrationsPlugin() {
  return {
    name: 'ai-office-integrations',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = new URL(req.url || '/', 'http://localhost').pathname;
        if (!path.startsWith('/api/integrations')) return next();
        try {
          if (req.method === 'GET' && path === '/api/integrations/status') {
            const [claudeOAuth, codexOAuth] = await Promise.all([inspectCliAuth('ClaudeOAuth'), inspectCliAuth('CodexOAuth')]);
            return json(res, 200, {providers: publicState(), cli: {ClaudeOAuth: claudeOAuth, CodexOAuth: codexOAuth}});
          }
          if (req.method === 'GET' && path === '/api/integrations/quotas') {
            return json(res, 200, await readQuotaOverview());
          }
          if (req.method === 'GET' && path === '/api/integrations/hermes/bots') {
            return json(res, 200, {bots: await readHermesBotRoster()});
          }
          if (req.method === 'GET' && path === '/api/integrations/codex/sessions') {
            const threads = await readCodexThreads();
            return json(res, 200, {sessions: threads.map(thread => ({
              id: thread.id,
              title: thread.title,
              preview: '',
              lastActive: thread.lastActive,
              messageCount: thread.messageCount,
              source: thread.source,
              agentNickname: thread.agentNickname,
              subagents: flattenCodexThreads(thread.subagents, thread.title).map(child => ({
                id: child.id,
                title: child.title,
                preview: child.preview,
                lastActive: child.lastActive,
                messageCount: child.messageCount,
                source: child.source,
                agentNickname: child.agentNickname,
                agentPath: child.agentPath,
                parentTitle: child.parentTitle,
              })),
            }))});
          }
          if (req.method === 'GET' && path === '/api/integrations/codex/agents') {
            return json(res, 200, {agents: await readCodexAgentRoster()});
          }
          if (req.method === 'POST' && path === '/api/integrations/codex/import') {
            const input = await body(req);
            const sessionIds = Array.isArray(input.sessionIds)
              ? [...new Set(input.sessionIds.map(id => String(id).slice(0, 200)).filter(Boolean))].slice(0, 12) : [];
            if (!sessionIds.length) return json(res, 400, {error: '請先選擇要匯入的 Codex 對話或子代理。'});
            const roots = await readCodexThreads();
            const available = flattenCodexThreads(roots);
            const availableById = new Map(available.map(thread => [thread.id, thread]));
            const selected = sessionIds.map(id => availableById.get(id)).filter(Boolean);
            if (!selected.length) return json(res, 409, {error: '找不到所選 Codex 對話或子代理；請重新讀取本機清單。'});
            const totalBytes = selected.reduce((total, thread) => total + thread.size, 0);
            if (totalBytes > 64 * 1024 * 1024) return json(res, 413, {error: '所選對話與子代理的歷史檔案超過 64 MB；請分批匯入。'});
            let remainingCharacters = 1_000_000;
            const imported = [];
            for (const thread of selected) {
              const full = await readCodexSession({path: thread.filePath, size: thread.size, modifiedAt: thread.lastActive, modifiedMs: thread.modifiedMs}, true);
              const safeId = value => String(value).replace(/[^A-Za-z0-9_-]/g, '').slice(-80) || randomUUID();
              const isSubagent = Boolean(thread.parentThreadId);
              const agentId = `${isSubagent ? 'codex-subagent-' : 'codex-agent-'}${safeId(thread.id)}`;
              const nickname = full.agentNickname || full.agentPath.split(/[\\/]/).filter(Boolean).at(-1) || '';
              const agentName = isSubagent ? nickname || 'Codex 子代理' : nickname || 'Codex CLI';
              const transcript = [];
              for (const message of full.messages) {
                if (remainingCharacters <= 0) break;
                const text = message.text.slice(0, remainingCharacters);
                remainingCharacters -= text.length;
                const parsedTime = message.timestamp ? new Date(message.timestamp) : null;
                const time = parsedTime && !Number.isNaN(parsedTime.valueOf())
                  ? parsedTime.toLocaleTimeString('zh-TW', {hour: '2-digit', minute: '2-digit', hour12: false}) : '';
                transcript.push({sender: message.role === 'user' ? 'user' : agentId, text, time, source: 'CodexCLI', timestamp: message.timestamp, ordinal: message.ordinal});
              }
              imported.push({
                id: thread.id,
                title: full.title,
                preview: full.preview,
                lastActive: full.lastActive,
                source: full.source,
                parentThreadId: full.parentThreadId,
                parentTitle: thread.parentTitle,
                isSubagent,
                agentNickname: full.agentNickname,
                agents: [{id: agentId, name: agentName.slice(0, 80), role: isSubagent ? 'Codex CLI 子代理' : 'Codex CLI 主控'}],
                messages: transcript.map(({sender, text, time, source}) => ({sender, text, time, source})),
              });
            }
            return json(res, 200, {sessions: imported, historyTruncated: remainingCharacters <= 0});
          }
          if (req.method === 'POST' && path === '/api/integrations/hermes/bot/connect') {
            const input = await body(req);
            const profileId = String(input.profileId || '');
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(profileId)) return json(res, 400, {error: 'Hermes profile 名稱格式錯誤。'});
            const bots = await readHermesBotRoster();
            const bot = bots.find(item => item.hermesProfileId === profileId);
            if (!bot) return json(res, 404, {error: '找不到這個 Hermes Bot Mode profile。'});
            const connection = connections.get('Hermes');
            if (!connection) return json(res, 409, {error: '請先連接目前 Hermes API Server。'});
            const previousCredential = hermesProfileCredentials.get(profileId);
            let apiKey = await readHermesProfileApiKey(profileId);
            let snapshot = null;
            const replacingSharedKey = apiKey && apiKey === connection.apiKey;
            if (!apiKey || replacingSharedKey) {
              apiKey = randomBytes(32).toString('base64url');
              snapshot = await writeHermesProfileApiKey(profileId, apiKey);
            }
            let models;
            try {
              const data = await requestJson(`${hermesApiRoot(connection)}/p/${encodeURIComponent(profileId)}/v1/models`, apiKey);
              models = (Array.isArray(data?.data) ? data.data : []).map(item => typeof item?.id === 'string' ? item.id : '').filter(Boolean).slice(0, 80);
              if (!models.length) throw new Error('這個 Hermes profile 沒有回報可用模型。');
              hermesProfileCredentials.set(profileId, {apiKey, model: models[0]});
              try { await writeEncryptedSettings(); }
              catch (error) {
                if (previousCredential) hermesProfileCredentials.set(profileId, previousCredential);
                else hermesProfileCredentials.delete(profileId);
                throw new Error('無法把 Bot profile 金鑰加密保存到 AI Office；Hermes profile 設定已還原。');
              }
            } catch (error) {
              if (snapshot) await restoreHermesProfileEnv(profileId, snapshot).catch(() => {});
              if (previousCredential) hermesProfileCredentials.set(profileId, previousCredential);
              else hermesProfileCredentials.delete(profileId);
              if (error instanceof UpstreamError && error.status === 404) {
                throw new Error(`Hermes gateway 目前沒有提供「${bot.name}」的 profile 路由；請確認此 profile 正由 multiplexer 服務後再重試。`);
              }
              throw error;
            }
            return json(res, 200, {ok: true, profileId, name: bot.name, model: models[0], models, apiServerConfigured: true});
          }
          if (req.method === 'POST' && path === '/api/integrations/connect') {
            const input = await body(req);
            const provider = input.provider;
            if (!['Hermes', 'Grok', 'Claude', 'OpenAI'].includes(provider)) return json(res, 404, {error: '不支援的來源。'});
            const apiKey = String(input.apiKey || '').trim();
            if (!apiKey) return json(res, 400, {error: '請輸入 API Server Key 或 API Key。'});
            const baseUrl = normalizeBaseUrl(input.baseUrl, provider);
            const data = await requestProviderJson(provider, `${baseUrl}/models`, apiKey);
            const models = (Array.isArray(data?.data) ? data.data : [])
              .map(item => typeof item?.id === 'string' ? item.id : '')
              .filter(Boolean).slice(0, 80);
            const model = String(input.model || '').trim() || models[0] || fallbackModel(provider);
            const connection = {id: randomUUID(), provider, baseUrl, apiKey, model, models, connectedAt: new Date().toISOString(), persisted: false};
            connections.set(provider, connection);
            const persisted = await rememberConnection(provider, connection);
            return json(res, 200, {
              ok: true,
              providers: publicState(),
              persisted,
              message: persisted
                ? `已連上 ${provider}，找到 ${models.length} 個模型，金鑰已加密保存。`
                : `已連上 ${provider}，找到 ${models.length} 個模型；本機加密保存失敗，伺服器關閉後需重新輸入金鑰。`,
            });
          }
          if (req.method === 'POST' && path === '/api/integrations/reconnect') {
            const input = await body(req);
            const provider = input.provider;
            if (!['Hermes', 'Grok', 'Claude', 'OpenAI'].includes(provider)) return json(res, 404, {error: '不支援的來源。'});
            const existing = connections.get(provider) || savedCredentials.get(provider);
            if (!existing) return json(res, 409, {error: `${provider} 沒有可重用的已保存金鑰，請輸入金鑰重新連線。`});
            const baseUrl = normalizeBaseUrl(input.baseUrl || existing.baseUrl, provider);
            if (baseUrl !== existing.baseUrl) return json(res, 409, {error: 'API 網址已更改；為避免把金鑰送往新網址，請重新輸入金鑰後連線。'});
            const data = await requestProviderJson(provider, `${baseUrl}/models`, existing.apiKey);
            const models = (Array.isArray(data?.data) ? data.data : [])
              .map(item => typeof item?.id === 'string' ? item.id : '')
              .filter(Boolean).slice(0, 80);
            const model = models.includes(existing.model) ? existing.model : models[0] || existing.model || fallbackModel(provider);
            const connection = {...existing, id: randomUUID(), provider, baseUrl, model, models, connectedAt: new Date().toISOString(), persisted: savedCredentials.has(provider)};
            connections.set(provider, connection);
            const persisted = await rememberConnection(provider, connection);
            return json(res, 200, {
              ok: true,
              providers: publicState(),
              persisted,
              message: persisted
                ? `已重新連上 ${provider}，找到 ${models.length} 個模型；金鑰仍以加密方式保存。`
                : `已重新連上 ${provider}，找到 ${models.length} 個模型；本機加密保存失敗。`,
            });
          }
          if (req.method === 'POST' && path === '/api/integrations/cli/connect') {
            const input = await body(req);
            const provider = input.provider;
            if (!['ClaudeOAuth', 'CodexOAuth'].includes(provider)) return json(res, 404, {error: '不支援的本機登入來源。'});
            const status = await inspectCliAuth(provider);
            if (!status.available || !status.loggedIn) return json(res, 409, {error: status.detail || '請先完成 CLI 登入。', cli: {[provider]: status}});
            const connection = {id: randomUUID(), provider, model: provider === 'CodexOAuth' ? 'Codex CLI OAuth' : 'Claude CLI OAuth', models: [], connectedAt: new Date().toISOString(), persisted: false};
            connections.set(provider, connection);
            return json(res, 200, {ok: true, providers: publicState(), cli: {[provider]: status}, message: `${status.detail}；已設為此辦公室的即時對話來源。`});
          }
          if (req.method === 'POST' && path === '/api/integrations/cli/login') {
            const input = await body(req);
            const provider = input.provider;
            if (!['ClaudeOAuth', 'CodexOAuth'].includes(provider)) return json(res, 404, {error: '不支援的本機登入來源。'});
            const command = provider === 'CodexOAuth' ? 'codex' : 'claude';
            const executable = await findExecutable(command);
            if (!executable) return json(res, 409, {error: `${command} CLI 未安裝或不在 PATH。`});
            if (process.env.AI_OFFICE_IN_DOCKER === '1') {
              const loginCommand = provider === 'CodexOAuth'
                ? 'docker compose exec ai-office codex login --device-auth'
                : 'docker compose exec ai-office claude auth login --claudeai';
              return json(res, 200, {ok: true, message: `請在專案目錄另開終端機執行：${loginCommand}。登入完成後，回到這裡按「重新讀取連線狀態」。`});
            }
            const loginArgs = provider === 'CodexOAuth' ? ['login'] : ['auth', 'login', '--claudeai'];
            const terminalCommand = [executable, ...loginArgs].map(value => `'${value.replace(/'/g, `'\\''`)}'`).join(' ');
            const script = `tell application "Terminal" to do script "${terminalCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
            const result = await runLocalCommand('/usr/bin/osascript', ['-e', script], {timeoutMs: 10_000});
            return json(res, 200, {ok: true, message: `${command} OAuth 登入流程已在 Terminal 開啟。登入完成後，回到此視窗按「重新讀取連線狀態」。`, detail: result.stdout.trim()});
          }
          if (req.method === 'POST' && path === '/api/integrations/cli/disconnect') {
            const input = await body(req);
            if (!['ClaudeOAuth', 'CodexOAuth'].includes(input.provider)) return json(res, 404, {error: '不支援的本機登入來源。'});
            connections.delete(input.provider);
            return json(res, 200, {ok: true, providers: publicState()});
          }
          if (req.method === 'GET' && path === '/api/integrations/hermes/sessions') {
            const connection = connections.get('Hermes');
            if (!connection) return json(res, 409, {error: '請先連接 Hermes Agent API。'});
            const url = new URL(`${hermesApiRoot(connection)}/api/sessions`);
            url.searchParams.set('limit', '100');
            url.searchParams.set('offset', '0');
            const data = await requestJson(url, connection.apiKey);
            const sessions = listFrom(data, 'sessions').map(normalizeHermesSession).filter(Boolean);
            return json(res, 200, {sessions, models: connection.models, activeModel: connection.model});
          }
          if (req.method === 'POST' && path === '/api/integrations/hermes/import') {
            const connection = connections.get('Hermes');
            if (!connection) return json(res, 409, {error: '請先連接 Hermes Agent API。'});
            const input = await body(req);
            const sessionIds = Array.isArray(input.sessionIds)
              ? [...new Set(input.sessionIds.map(id => String(id).slice(0, 300)).filter(Boolean))].slice(0, 40) : [];
            if (!sessionIds.length) return json(res, 400, {error: '請至少選擇一個工作階段。'});
            const imported = [];
            let remainingHistoryCharacters = 1_000_000;
            for (let index = 0; index < sessionIds.length; index += 5) {
              const batch = await Promise.all(sessionIds.slice(index, index + 5).map(async id => {
                const url = `${hermesApiRoot(connection)}/api/sessions/${encodeURIComponent(id)}/messages`;
                try {
                  const data = await requestJson(url, connection.apiKey);
                  return {id, messages: normalizeHermesMessages(data), historyAvailable: true};
                } catch (error) {
                  if (error instanceof UpstreamError && error.status === 404) return {id, messages: [], historyAvailable: false};
                  throw error;
                }
              }));
              for (const session of batch) {
                const messages = [];
                let historyTruncated = false;
                for (const message of session.messages) {
                  if (remainingHistoryCharacters <= 0) { historyTruncated = true; break; }
                  const text = message.text.slice(0, remainingHistoryCharacters);
                  if (text.length < message.text.length) historyTruncated = true;
                  remainingHistoryCharacters -= text.length;
                  messages.push({...message, text});
                }
                if (messages.length < session.messages.length) historyTruncated = true;
                imported.push({...session, messages, historyTruncated});
              }
            }
            return json(res, 200, {sessions: imported});
          }
          if (req.method === 'POST' && path === '/api/integrations/disconnect') {
            const input = await body(req);
            if (!['Hermes', 'Grok', 'Claude', 'OpenAI'].includes(input.provider)) return json(res, 404, {error: '不支援的來源。'});
            const priorConnection = connections.get(input.provider);
            const priorSaved = savedCredentials.get(input.provider);
            connections.delete(input.provider);
            savedCredentials.delete(input.provider);
            try { await writeEncryptedSettings(); }
            catch {
              if (priorConnection) connections.set(input.provider, priorConnection);
              if (priorSaved) savedCredentials.set(input.provider, priorSaved);
              return json(res, 500, {error: '無法更新本機加密設定；連線與已保存金鑰都已保留。'});
            }
            return json(res, 200, {ok: true, providers: publicState()});
          }
          if (req.method === 'POST' && path === '/api/integrations/model') {
            const input = await body(req);
            const connection = connections.get(input.provider);
            if (!connection) return json(res, 409, {error: `${input.provider} 尚未連線。`});
            if (!connection.models.includes(input.model)) return json(res, 400, {error: '這個模型不在來源回傳的清單中。'});
            const previousModel = connection.model;
            connection.model = input.model;
            if (!await rememberConnection(input.provider, connection)) {
              connection.model = previousModel;
              return json(res, 500, {error: '無法更新本機加密設定，模型設定未變更。'});
            }
            return json(res, 200, {ok: true, providers: publicState()});
          }
          if (req.method === 'POST' && path === '/api/integrations/chat') {
            const input = await body(req);
            if (['ClaudeOAuth', 'CodexOAuth'].includes(input.provider)) {
              const connection = connections.get(input.provider);
              if (!connection) return json(res, 409, {error: `請先連接 ${input.provider === 'CodexOAuth' ? 'Codex CLI OAuth' : 'Claude CLI OAuth'}。`});
              const auth = await inspectCliAuth(input.provider);
              if (!auth.loggedIn) return json(res, 409, {error: auth.detail || '本機 CLI 登入已失效，請重新登入。'});
              const messages = Array.isArray(input.messages) ? input.messages.slice(-32) : [];
              if (!messages.length || messages.some(message => !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')) return json(res, 400, {error: '對話內容格式錯誤。'});
              const result = await chatWithLocalCli(input.provider, messages);
              if (!result.text?.trim()) throw new Error('本機 CLI 沒有回傳文字內容。');
              return json(res, 200, {text: result.text.slice(0, 24_000), model: result.model});
            }
            const connection = connections.get(input.provider);
            if (!connection) return json(res, 409, {error: `${input.provider} 尚未連線，請先在「連接來源」完成連線。`});
            const messages = Array.isArray(input.messages) ? input.messages.slice(-32) : [];
            if (!messages.length || messages.some(message => !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')) {
              return json(res, 400, {error: '對話內容格式錯誤。'});
            }
            let requestUrl = `${connection.baseUrl}/chat/completions`;
            let apiKey = connection.apiKey;
            let model = connection.model;
            const profileId = input.provider === 'Hermes' ? String(input.hermesProfileId || '') : '';
            if (input.model && !profileId) {
              const requestedModel = String(input.model);
              if (!connection.models.includes(requestedModel)) return json(res, 400, {error: '這個模型不在來源回傳的清單中。'});
              model = requestedModel;
            }
            if (profileId) {
              if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(profileId)) return json(res, 400, {error: 'Hermes profile 名稱格式錯誤。'});
              if (!(await readHermesBotRoster()).some(bot => bot.hermesProfileId === profileId)) return json(res, 404, {error: '找不到這個 Hermes Bot Mode profile。'});
              const profileCredential = hermesProfileCredentials.get(profileId);
              apiKey = profileCredential?.apiKey || await readHermesProfileApiKey(profileId);
              if (!apiKey) return json(res, 409, {error: `這個 Hermes Bot profile 尚未啟用專屬 API 連線。請先選「啟用 Bot 對話」。`});
              requestUrl = `${hermesApiRoot(connection)}/p/${encodeURIComponent(profileId)}/v1/chat/completions`;
              const profileModel = profileCredential?.model || '';
              if (input.model && input.model !== profileModel) {
                const modelData = await requestJson(`${hermesApiRoot(connection)}/p/${encodeURIComponent(profileId)}/v1/models`, apiKey);
                const models = Array.isArray(modelData?.data) ? modelData.data.map(item => item?.id).filter(item => typeof item === 'string') : [];
                if (!models.includes(String(input.model))) return json(res, 400, {error: '這個模型不在 Hermes Bot profile 回傳的清單中。'});
                model = String(input.model);
              } else if (profileModel) {
                model = profileModel;
              } else {
                const modelData = await requestJson(`${hermesApiRoot(connection)}/p/${encodeURIComponent(profileId)}/v1/models`, apiKey);
                model = modelData?.data?.find(item => typeof item?.id === 'string')?.id || model;
              }
            }
            let result;
            try {
              if (connection.provider === 'Claude') {
                const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
                const claudeMessages = messages.filter(message => message.role !== 'system').map(message => ({role: message.role, content: message.content}));
                result = await requestClaudeJson(`${connection.baseUrl}/messages`, apiKey, {
                  method: 'POST',
                  body: JSON.stringify({model, max_tokens: 2048, ...(system ? {system} : {}), messages: claudeMessages}),
                }, 120_000);
              } else {
                result = await requestJson(requestUrl, apiKey, {
                  method: 'POST',
                  headers: connection.provider === 'Hermes' && typeof input.sessionId === 'string'
                    ? {'X-Hermes-Session-Id': input.sessionId.slice(0, 180)} : {},
                  body: JSON.stringify({model, messages, stream: false}),
                }, 120_000);
              }
            } catch (error) {
              if (connection.provider === 'Hermes' && ['TimeoutError', 'AbortError'].includes(error?.name)) {
                const timeout = new Error('Hermes 兩分鐘內沒有完成回覆。工作階段可能已建立，請先到 Hermes 確認上一則是否仍在執行，再決定是否重試。');
                timeout.name = 'TimeoutError';
                throw timeout;
              }
              throw error;
            }
            const content = connection.provider === 'Claude' ? result?.content : result?.choices?.[0]?.message?.content;
            const text = typeof content === 'string' ? content : Array.isArray(content)
              ? content.map(part => typeof part?.text === 'string' ? part.text : '').join('') : '';
            if (!text.trim()) throw new Error('來源沒有回傳文字內容。');
            return json(res, 200, {text, model: result?.model || model});
          }
          return json(res, 404, {error: '找不到這個連線端點。'});
        } catch (error) {
          return sendError(res, error);
        }
      });
    },
  };
}

// Settings secrets are encrypted with AES-GCM; the encryption key lives in macOS Keychain.
export async function loadEnvironmentConnections() {
  try {
    const stored = await readEncryptedSettings();
    integrationBridgeConfig = stored.integrationBridge && typeof stored.integrationBridge === 'object' ? stored.integrationBridge : null;
    for (const [profileId, credential] of Object.entries(stored.hermesProfiles || {})) {
      if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(profileId) && typeof credential?.apiKey === 'string' && credential.apiKey) {
        hermesProfileCredentials.set(profileId, {apiKey: credential.apiKey, model: typeof credential.model === 'string' ? credential.model : ''});
      }
    }
    for (const provider of ['Hermes', 'Grok', 'Claude', 'OpenAI']) {
      const entry = stored.providers?.[provider];
      if (!entry || typeof entry.apiKey !== 'string' || typeof entry.baseUrl !== 'string') continue;
      const baseUrl = normalizeBaseUrl(entry.baseUrl, provider);
      const credential = {baseUrl, apiKey: entry.apiKey, model: typeof entry.model === 'string' ? entry.model : ''};
      savedCredentials.set(provider, credential);
      try {
        const data = await requestProviderJson(provider, `${baseUrl}/models`, credential.apiKey);
        const models = (Array.isArray(data?.data) ? data.data : []).map(item => item?.id).filter(id => typeof id === 'string').slice(0, 80);
        const model = models.includes(credential.model) ? credential.model : models[0] || credential.model || fallbackModel(provider);
        const connection = {id: randomUUID(), provider, baseUrl, apiKey: credential.apiKey, model, models, connectedAt: new Date().toISOString(), persisted: true};
        connections.set(provider, connection);
        if (model !== credential.model) await rememberConnection(provider, connection);
      } catch {
        console.warn(`[AI Office] Saved ${provider} credentials are available, but the endpoint could not be reached.`);
      }
    }
  } catch {
    console.warn('[AI Office] Encrypted settings could not be read; saved connections need attention.');
  }

  for (const provider of ['Hermes', 'Grok', 'Claude', 'OpenAI']) {
    const {apiKey, baseUrl} = defaults[provider];
    if (!apiKey) continue;
    try {
      const normalized = normalizeBaseUrl(baseUrl, provider);
      const data = await requestProviderJson(provider, `${normalized}/models`, apiKey);
      const models = (Array.isArray(data?.data) ? data.data : []).map(item => item?.id).filter(id => typeof id === 'string').slice(0, 80);
      const connection = {id: randomUUID(), provider, baseUrl: normalized, apiKey, model: models[0] || fallbackModel(provider), models, connectedAt: new Date().toISOString(), persisted: false};
      connections.set(provider, connection);
      await rememberConnection(provider, connection);
    } catch {
      console.warn(`[AI Office] ${provider} environment connection unavailable.`);
    }
  }
}

export async function readIntegrationBridgeConfig() {
  if (integrationBridgeConfig) return structuredClone(integrationBridgeConfig);
  const stored = await readEncryptedSettings();
  integrationBridgeConfig = stored.integrationBridge && typeof stored.integrationBridge === 'object' ? stored.integrationBridge : null;
  return integrationBridgeConfig ? structuredClone(integrationBridgeConfig) : null;
}

export async function saveIntegrationBridgeConfig(config) {
  const stored = await readEncryptedSettings();
  for (const [provider, credential] of Object.entries(stored.providers || {})) {
    if (!savedCredentials.has(provider) && credential?.apiKey && credential?.baseUrl) savedCredentials.set(provider, credential);
  }
  for (const [profileId, credential] of Object.entries(stored.hermesProfiles || {})) {
    if (!hermesProfileCredentials.has(profileId) && credential?.apiKey) hermesProfileCredentials.set(profileId, credential);
  }
  const workerUrl = new URL(String(config?.workerUrl || ''));
  if (workerUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(workerUrl.hostname)) throw new Error('Worker URL must use HTTPS.');
  const token = String(config?.token || '');
  if (token.length < 32 || token.length > 256) throw new Error('Bridge token must be 32-256 characters.');
  if (!config?.agents || typeof config.agents !== 'object' || Array.isArray(config.agents)) throw new Error('Agent routes are required.');
  const agents = {};
  for (const [id, route] of Object.entries(config.agents)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id) || !['Hermes', 'Grok', 'Claude', 'OpenAI', 'ClaudeOAuth', 'CodexOAuth'].includes(route?.provider)) throw new Error(`Invalid route for Agent ${id}.`);
    if (['ClaudeOAuth', 'CodexOAuth'].includes(route.provider) && route.model) throw new Error(`CLI route ${id} does not accept a model override.`);
    agents[id.toLowerCase()] = {
      provider: route.provider,
      model: String(route.model || '').slice(0, 120),
      systemPrompt: String(route.systemPrompt || '').slice(0, 4000),
      ...(route.provider === 'Hermes' && route.hermesProfileId ? {hermesProfileId: String(route.hermesProfileId)} : {}),
    };
  }
  const previous = integrationBridgeConfig;
  integrationBridgeConfig = {workerUrl: workerUrl.origin, token, agents};
  try { await writeEncryptedSettings(); }
  catch (error) { integrationBridgeConfig = previous; throw error; }
  return {workerUrl: workerUrl.origin, agents: Object.keys(agents)};
}
