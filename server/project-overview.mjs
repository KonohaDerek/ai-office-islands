// Read-only Herdr project overview for the local dev server (issue #8).
// Runs two fixed, allowlisted metadata commands via execFile (never a shell),
// keeps only project name/ID plus terminal status counts, and never exposes
// terminal text, prompts, paths, labels, exit codes or other free text.
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';

export const OVERVIEW_PATH = '/api/project-overview';
export const SNAPSHOT_TTL_MS = 5_000;
export const MIN_REFRESH_INTERVAL_MS = 2_000;
export const STALE_AFTER_MS = 60_000;
export const COMMAND_TIMEOUT_MS = 4_000;
export const COMMAND_MAX_BYTES = 1024 * 1024;
const MAX_PROJECTS = 100;
const MAX_TERMINALS = 500;

// The only commands this adapter may run. `--json` is the machine-readable
// form of `hc ls --all`; nothing from a request ever reaches argv.
export const ALLOWED_COMMANDS = Object.freeze({
  herdr: Object.freeze({file: 'herdr-app', args: Object.freeze(['ls'])}),
  hc: Object.freeze({file: 'hc', args: Object.freeze(['ls', '--all', '--json'])}),
});

// Agent turn states. `review` is a finished agent turn, which is not product completion.
export const STATUS_RANK = Object.freeze({blocked: 0, review: 1, waiting: 2, unknown: 3, working: 4, none: 5});
const TERMINAL_STATUS = {blocked: 'blocked', done: 'review', idle: 'waiting', working: 'working'};
const AGENT_KINDS = new Set(['claude-code', 'codex', 'hermes']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const SECRET_PATTERN = /(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{10,}|[A-Za-z0-9+/_-]{32,})/;
const PATH_PATTERN = /(^[~/.]|[\\/]|^[A-Za-z]:)/;

export function sanitizeLabel(value, fallback = '未命名專案') {
  if (typeof value !== 'string') return fallback;
  const text = value
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/[<>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || PATH_PATTERN.test(text) || SECRET_PATTERN.test(text)) return fallback;
  return [...text].slice(0, 60).join('');
}

// Distinct spaces may share an ID; suffix later ones in source order so output IDs stay unique.
function uniqueId(id, used) {
  let candidate = id;
  for (let n = 2; used.has(candidate); n += 1) candidate = `${id}~${n}`;
  used.add(candidate);
  return candidate;
}

export function safeProjectId(value) {
  if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)) return value;
  return 'p_' + createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16);
}

function terminalStatus(raw) {
  return typeof raw === 'string' && Object.hasOwn(TERMINAL_STATUS, raw) ? TERMINAL_STATUS[raw] : 'unknown';
}

// hc ls reports Claude Code as `claude`; Herdr's app field uses `claude-code`.
const AGENT_ALIASES = {claude: 'claude-code'};

function agentKind(raw) {
  const kind = typeof raw === 'string' && Object.hasOwn(AGENT_ALIASES, raw) ? AGENT_ALIASES[raw] : raw;
  return typeof kind === 'string' && AGENT_KINDS.has(kind) ? kind : kind ? 'other' : '';
}

function parseJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function emptyCounts() {
  return {blocked: 0, review: 0, waiting: 0, unknown: 0, working: 0};
}

function rollupStatus(counts, agents) {
  if (!agents) return 'none';
  return Object.keys(counts).sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b]).find(key => counts[key] > 0) || 'unknown';
}

export function compareProjects(a, b) {
  return (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
    || b.counts.blocked - a.counts.blocked
    || (b.counts.review + b.counts.waiting) - (a.counts.review + a.counts.waiting)
    || a.name.localeCompare(b.name, 'zh-Hant')
    || a.id.localeCompare(b.id);
}

// Builds the public snapshot from raw command results:
// {herdr: {ok, stdout?, error?}, hc: {ok, stdout?, error?}}.
export function normalizeSnapshot(results, observedAt = new Date().toISOString()) {
  const sources = {};
  const herdrData = results?.herdr?.ok ? parseJson(results.herdr.stdout) : null;
  const herdrSpaces = Array.isArray(herdrData?.spaces) ? herdrData.spaces : null;
  sources.herdr = sourceState(results?.herdr, herdrSpaces, observedAt);
  const hcData = results?.hc?.ok ? parseJson(results.hc.stdout) : null;
  const hcTerminals = Array.isArray(hcData?.terminals) ? hcData.terminals : null;
  sources.hc = sourceState(results?.hc, hcTerminals, observedAt);

  const hcOk = sources.hc.state === 'ok';
  const hcByAddress = new Map();
  for (const terminal of (hcTerminals || []).slice(0, MAX_TERMINALS)) {
    if (terminal && typeof terminal.address === 'string') hcByAddress.set(terminal.address, terminal);
  }

  const seenAddresses = new Set();
  const usedIds = new Set();
  const spaces = (herdrSpaces || []).slice(0, MAX_PROJECTS).filter(space => space && typeof space === 'object');
  const projects = spaces.map(space => {
    const counts = emptyCounts();
    const agentsByKind = {};
    let agents = 0, unidentified = 0, shells = 0, subAgents = 0, tabs = 0;
    for (const tab of Array.isArray(space.tabs) ? space.tabs : []) {
      tabs += 1;
      for (const terminal of Array.isArray(tab?.terminals) ? tab.terminals : []) {
        const address = typeof terminal?.terminal === 'string' ? terminal.terminal : '';
        if (address) seenAddresses.add(address);
        const hc = address ? hcByAddress.get(address) : null;
        const kind = agentKind(terminal?.app || hc?.agent);
        // No app from Herdr and nothing from hc to vouch for it: identity is unknown, not a shell.
        if (!kind) { unidentified += 1; counts.unknown += 1; continue; }
        if (!AGENT_KINDS.has(kind)) { shells += 1; continue; }
        agents += 1;
        agentsByKind[kind] = (agentsByKind[kind] || 0) + 1;
        const status = terminalStatus(terminal?.status ?? hc?.status);
        counts[status] += 1;
        if (Array.isArray(terminal?.sub_agents)) subAgents += Math.min(terminal.sub_agents.length, 50);
      }
    }
    return {
      id: uniqueId(safeProjectId(space.id), usedIds),
      name: sanitizeLabel(space.name),
      status: rollupStatus(counts, agents + unidentified),
      counts,
      agents,
      unidentified,
      agentsByKind,
      shells,
      subAgents,
      tabs,
      ended: hcOk ? 0 : null,
      updatedAt: null,
      timeBasis: 'observed',
    };
  });

  // Finished terminals are only in hc; attribute them by exact, unique space name.
  const byName = new Map();
  for (const [index, space] of spaces.entries()) {
    if (typeof space?.name !== 'string') continue;
    byName.set(space.name, byName.has(space.name) ? null : projects[index]);
  }
  let unattributedEnded = hcOk ? 0 : null;
  for (const terminal of hcByAddress.values()) {
    if (terminal.state !== 'finished' || seenAddresses.has(terminal.address)) continue;
    const spaceName = typeof terminal.where === 'string' ? terminal.where.split(' / ')[0] : '';
    const project = byName.get(spaceName);
    if (project) project.ended += 1; else unattributedEnded += 1;
  }

  projects.sort(compareProjects);
  const available = sources.herdr.state === 'ok';
  return {
    version: 1,
    available,
    observedAt,
    updatedAt: null,
    timeBasis: 'observed',
    staleAfterMs: STALE_AFTER_MS,
    sources,
    projects: available ? projects : [],
    unattributedEnded,
  };
}

function sourceState(result, parsed, observedAt) {
  if (!result) return {state: 'unknown', error: 'not_run', observedAt};
  if (!result.ok) return {state: 'error', error: result.error || 'failed', observedAt};
  if (!parsed) return {state: 'error', error: 'invalid_output', observedAt};
  return {state: 'ok', error: null, observedAt};
}

export function classifyExecError(error) {
  if (!error) return 'failed';
  if (error.code === 'ENOENT') return 'not_found';
  if (error.killed || error.signal === 'SIGKILL' || error.code === 'ETIMEDOUT') return 'timeout';
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output_too_large';
  return 'failed';
}

export function runAllowlistedCommand(key, exec = execFile) {
  const command = ALLOWED_COMMANDS[key];
  if (!command) return Promise.resolve({ok: false, error: 'not_allowed'});
  return new Promise(resolve => {
    exec(command.file, [...command.args], {
      shell: false,
      timeout: COMMAND_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: COMMAND_MAX_BYTES,
      windowsHide: true,
      encoding: 'utf8',
      env: {PATH: process.env.PATH || '', HOME: process.env.HOME || '', LANG: 'C.UTF-8'},
    }, (error, stdout) => {
      resolve(error ? {ok: false, error: classifyExecError(error)} : {ok: true, stdout: String(stdout)});
    });
  });
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  const plain = address.replace(/^::ffff:/i, '');
  return plain === '::1' || /^127(\.\d{1,3}){3}$/.test(plain);
}

function hostName(value) {
  if (typeof value !== 'string' || !value) return '';
  try { return new URL(`http://${value}`).hostname.toLowerCase(); } catch { return ''; }
}

// Returns null when the request may read the snapshot, else {status, error}.
export function rejectRequest(req) {
  if (req.method !== 'GET') return {status: 405, error: 'method_not_allowed'};
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return {status: 403, error: 'loopback_only'};
  const host = req.headers?.host;
  if (!LOOPBACK_HOSTS.has(hostName(host))) return {status: 403, error: 'host_not_allowed'};
  const origin = req.headers?.origin;
  if (origin !== undefined) {
    let parsed;
    try { parsed = new URL(origin); } catch { return {status: 403, error: 'origin_not_allowed'}; }
    if (parsed.protocol !== 'http:' || parsed.host.toLowerCase() !== String(host).toLowerCase()) return {status: 403, error: 'origin_not_allowed'};
  }
  const site = req.headers?.['sec-fetch-site'];
  if (site !== undefined && !['same-origin', 'none'].includes(site)) return {status: 403, error: 'cross_site'};
  return null;
}

export function overviewDisabled(env = process.env) {
  return env.VITE_PUBLIC_DEMO === 'true' || env.AI_OFFICE_PROJECT_OVERVIEW === 'off';
}

// One shared snapshot for every client; concurrent requests reuse the same run.
export function createSnapshotStore({run = runAllowlistedCommand, now = () => Date.now()} = {}) {
  let snapshot = null, takenAt = 0, inFlight = null;
  return async function getSnapshot({refresh = false} = {}) {
    const age = now() - takenAt;
    if (snapshot && (age < (refresh ? MIN_REFRESH_INTERVAL_MS : SNAPSHOT_TTL_MS))) return snapshot;
    if (!inFlight) {
      inFlight = Promise.all([run('herdr'), run('hc')])
        .then(([herdr, hc]) => {
          takenAt = now();
          snapshot = normalizeSnapshot({herdr, hc}, new Date(takenAt).toISOString());
          return snapshot;
        })
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  };
}

function send(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(value));
}

export function createOverviewHandler({env = process.env, getSnapshot = createSnapshotStore()} = {}) {
  return async function handle(req, res, next) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== OVERVIEW_PATH) return next();
    if (overviewDisabled(env)) return send(res, 404, {available: false, error: 'disabled'});
    const rejected = rejectRequest(req);
    if (rejected) {
      if (rejected.status === 405) res.setHeader('Allow', 'GET');
      return send(res, rejected.status, {available: false, error: rejected.error});
    }
    try {
      return send(res, 200, await getSnapshot({refresh: url.searchParams.get('refresh') === '1'}));
    } catch {
      return send(res, 500, {available: false, error: 'snapshot_failed'});
    }
  };
}

export function projectOverviewPlugin() {
  return {
    name: 'ai-office-project-overview',
    configureServer(server) {
      server.middlewares.use(createOverviewHandler());
    },
  };
}
