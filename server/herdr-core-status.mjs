// Herdr Core (`hc`) terminal status source and explicit message route for the local dev server (issue #12).
// Speaks Herdr Core's Socket API: JSON-RPC 2.0, one message per line on the core's local
// Unix socket (protocol generation 1). Status is only what programs report through OSC 7501;
// nothing is inferred from screens, output or titles. The status stream is read-only. The only
// write is `terminal.send`, made once per explicit user Send to a listed, repo-labelled agent after
// a fresh `terminal.get` re-check. This module never starts a subprocess and never reads terminal output.
import net from 'node:net';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, join} from 'node:path';
import {rejectRequest} from './project-overview.mjs';

export const AGENT_STATUS_PATH = '/api/agent-status';
export const AGENT_MESSAGE_PATH = '/api/agent-status/message';
export const CORE_GENERATION = 1;
export const CORE_STATES = Object.freeze(['idle', 'working', 'blocked', 'done', 'error']);
// Product code may only call these. The status stream uses STATUS_METHODS; one explicit message uses
// SEND_METHODS on its own connection. terminal.read/attach/keys/kill/run/interrupt, machine.exec, file.*,
// doc.* and terminal.list never reach the socket.
export const STATUS_METHODS = Object.freeze(['hello', 'events.subscribe']);
export const SEND_METHODS = Object.freeze(['hello', 'terminal.get', 'terminal.send']);
export const ALLOWED_METHODS = Object.freeze(['hello', 'events.subscribe', 'terminal.get', 'terminal.send']);
// terminal.send only ever types into a program that reports one of these, enforced by Core's `if`.
export const SENDABLE_STATES = Object.freeze(['idle', 'working']);
// This app only watches terminals labelled for this repository; it never subscribes unfiltered.
export const DEFAULT_LABEL_FILTER = Object.freeze({repo: 'ai-office-islands'});
// The only fields kept from a Core terminal record; everything else is discarded at ingress.
export const RETAINED_FIELDS = Object.freeze(['address', 'state', 'statusState', 'progress', 'app', 'reported']);
// Generic agent kinds a program may name in its 7501 `app` field; anything else is dropped.
export const AGENT_KINDS = Object.freeze({claude: 'Claude Code', 'claude-code': 'Claude Code', codex: 'Codex', hermes: 'Hermes', gemini: 'Gemini CLI', aider: 'Aider', opencode: 'OpenCode', goose: 'Goose', amp: 'Amp'});
// The foreground program names accepted as each runtime's identity. Interpreters (node, python, sh),
// wrappers and version-string process titles are not identities, so such terminals fail closed.
const FOREGROUND_RUNTIMES = Object.freeze({claude: 'claude', codex: 'codex', hermes: 'hermes', gemini: 'gemini', aider: 'aider', opencode: 'opencode', goose: 'goose', amp: 'amp'});
const APP_RUNTIMES = Object.freeze({claude: 'claude', 'claude-code': 'claude', codex: 'codex', hermes: 'hermes', gemini: 'gemini', aider: 'aider', opencode: 'opencode', goose: 'goose', amp: 'amp'});
export const REQUEST_TIMEOUT_MS = 4_000;
// terminal.send waits for the person's draft (≤ 60 s) or ~3 s of quiet before typing.
export const SEND_TIMEOUT_MS = 75_000;
export const MAX_MESSAGE_CHARS = 4_000;
export const MAX_MESSAGE_BODY_BYTES = 16 * 1024;
// Core error kinds that mean terminal.send did not type anything.
const SEND_REFUSALS = new Set(['not_found', 'machine_unknown', 'finished', 'unavailable', 'blocked', 'status_mismatch', 'invalid_params', 'config']);
// Core sends a heartbeat every 15 s; three silent intervals mean the stream is stale.
export const STALE_AFTER_MS = 45_000;
export const RECONNECT_DELAYS_MS = Object.freeze([1_000, 2_000, 5_000, 10_000, 15_000]);
export const IDLE_STOP_MS = 45_000;
export const MAX_LINE_BYTES = 16 * 1024 * 1024;
export const MAX_TERMINALS = 200;
const MAX_PENDING_NOTIFICATIONS = 1000;
const ADDRESS_PATTERN = /^t[0-9A-Za-z]{1,32}$/;
const SESSION_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export function normalizeCoreStatus(status) {
  const state = status && typeof status === 'object' ? status.state : undefined;
  return typeof state === 'string' && CORE_STATES.includes(state) ? state : 'unknown';
}

export function agentKind(app) {
  return typeof app === 'string' && Object.hasOwn(AGENT_KINDS, app.trim().toLowerCase()) ? app.trim().toLowerCase() : '';
}

export function matchesLabels(labels, filter) {
  if (!labels || typeof labels !== 'object') return false;
  return Object.entries(filter).every(([key, value]) => labels[key] === value);
}

function projectStatus(status) {
  if (!status || typeof status !== 'object') return {statusState: null, progress: null, app: ''};
  const statusState = typeof status.state === 'string' && CORE_STATES.includes(status.state) ? status.state : typeof status.state === 'string' ? 'unrecognized' : null;
  const progress = Number.isInteger(status.progress) && status.progress >= 0 && status.progress <= 100 ? status.progress : null;
  return {statusState, progress, app: agentKind(status.app)};
}

// Ingress projection: called on every record Core sends, before anything is stored.
// Name, title, argv, cwd, foreground, labels, screen, status msg/title and records are dropped here.
export function projectTerminal(raw, filter = DEFAULT_LABEL_FILTER) {
  if (!raw || typeof raw !== 'object' || typeof raw.address !== 'string' || !ADDRESS_PATTERN.test(raw.address)) return null;
  if (!matchesLabels(raw.labels, filter)) return null;
  return {address: raw.address, state: raw.state === 'live' ? 'live' : 'finished', ...projectStatus(raw.status), reported: raw.reported === true};
}

// Send-time projection of a fresh terminal.get record: whether it is still the same repo-labelled,
// live, sendable agent. Only these derived values are kept; the raw record (and its foreground) is dropped.
export function projectSendTarget(raw, filter = DEFAULT_LABEL_FILTER) {
  if (!raw || typeof raw !== 'object' || typeof raw.address !== 'string' || !ADDRESS_PATTERN.test(raw.address)) return null;
  const status = raw.status && typeof raw.status === 'object' ? raw.status : null;
  return {
    address: raw.address,
    labelsMatch: matchesLabels(raw.labels, filter),
    live: raw.state === 'live',
    reported: raw.reported === true,
    ...projectStatus(status),
    // A blocked program may say it is in a permission, question or auth dialog; never type into one.
    dialog: Boolean(status && status.kind !== undefined && status.kind !== null),
    runtime: foregroundRuntime(raw.foreground),
  };
}

// The generic runtime named by the foreground program, '' when unknown, 'ambiguous' when its name and argv[0] disagree.
export function foregroundRuntime(foreground) {
  if (!foreground || typeof foreground !== 'object') return '';
  const names = [foreground.name, Array.isArray(foreground.argv) ? foreground.argv[0] : undefined]
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => basename(value.trim()).toLowerCase());
  if (!names.length) return '';
  const runtimes = new Set(names.map(name => Object.hasOwn(FOREGROUND_RUNTIMES, name) ? FOREGROUND_RUNTIMES[name] : ''));
  if (runtimes.size > 1) return 'ambiguous';
  return [...runtimes][0];
}

// Why a target must not receive a message, or '' when it may. `listed` is the record the user picked.
export function sendTargetRefusal(fresh, listed) {
  if (!fresh || !listed || fresh.address !== listed.address) return 'target_changed';
  if (!fresh.labelsMatch) return 'label_mismatch';
  if (!fresh.live) return 'not_live';
  if (!fresh.reported || !fresh.statusState) return 'status_unknown';
  if (fresh.dialog || fresh.statusState === 'blocked') return 'blocked';
  if (!SENDABLE_STATES.includes(fresh.statusState)) return 'not_sendable_status';
  if (!fresh.app) return 'unknown_app';
  if (!fresh.runtime) return 'unknown_identity';
  if (fresh.runtime === 'ambiguous') return 'ambiguous_identity';
  if (fresh.runtime !== APP_RUNTIMES[fresh.app]) return 'identity_mismatch';
  if (!listed.kind || APP_RUNTIMES[listed.kind] !== fresh.runtime) return 'target_changed';
  return '';
}

// A message is plain text: no escape or other control characters that could steer the terminal itself.
export function validMessageText(text) {
  return typeof text === 'string' && text.trim().length > 0 && text.length <= MAX_MESSAGE_CHARS && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(text);
}

function configSocket(env, home) {
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config');
  try {
    const text = readFileSync(join(configHome, 'herdr-core', 'config.toml'), 'utf8');
    // Only a top-level `socket = "..."` before any [table] counts.
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) break;
      const match = line.match(/^\s*socket\s*=\s*"([^"\\]+)"\s*(#.*)?$/);
      if (match) return match[1].replace(/^~(?=\/)/, home);
    }
  } catch {}
  return '';
}

// Herdr Core endpoint rules: HC_SOCKET, then config `socket`, then
// $XDG_RUNTIME_DIR/herdr-core/, then /run/user/<uid>/herdr-core/, then the session state dir.
export function resolveCoreSocketPath({env = process.env, home = homedir(), uid = process.getuid?.(), exists = existsSync} = {}) {
  if (typeof env.HC_SOCKET === 'string' && env.HC_SOCKET) return env.HC_SOCKET;
  const fromConfig = configSocket(env, home);
  if (fromConfig) return fromConfig;
  const session = typeof env.HC_SESSION === 'string' && SESSION_PATTERN.test(env.HC_SESSION) ? env.HC_SESSION : 'default';
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, 'herdr-core', `${session}.sock`);
  if (Number.isInteger(uid) && exists(`/run/user/${uid}`)) return join(`/run/user/${uid}`, 'herdr-core', `${session}.sock`);
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'herdr-core', session, `${session}.sock`);
}

// A stable, opaque key so identical terminal addresses on different cores stay distinct without exposing the path.
export function coreSourceKey(socketPath) {
  return 'c' + createHash('sha256').update(String(socketPath)).digest('hex').slice(0, 10);
}

function coreError(code, fromCore = false) {
  return Object.assign(new Error(code), {code, fromCore});
}

// Refuses a request before it reaches the socket unless the method is allowlisted for this connection
// and its parameters have the only shape this app sends.
function assertRequestAllowed(methods, method, params) {
  if (!methods.includes(method) || !ALLOWED_METHODS.includes(method)) throw new Error(`Herdr Core method not allowed: ${method}`);
  const keys = Object.keys(params || {}).sort().join(',');
  if (method === 'terminal.get' && (keys !== 'terminal' || !ADDRESS_PATTERN.test(params.terminal))) throw new Error('Herdr Core terminal.get parameters not allowed');
  if (method === 'terminal.send' && (keys !== 'if,terminal,text' || !ADDRESS_PATTERN.test(params.terminal) || !SENDABLE_STATES.includes(params.if) || !validMessageText(params.text))) {
    throw new Error('Herdr Core terminal.send parameters not allowed');
  }
}

// One plain-mode JSON-RPC connection. Requests are refused unless allowlisted.
export function openCoreConnection(connect, socketPath, {onNotification, onClose, timeoutMs = REQUEST_TIMEOUT_MS, methods = STATUS_METHODS}) {
  const socket = connect(socketPath);
  const pending = new Map();
  let buffer = '', closed = false, nextId = 1;
  const finish = reason => {
    if (closed) return;
    closed = true;
    socket.destroy();
    for (const {reject, timer} of pending.values()) { clearTimeout(timer); reject(coreError(reason || 'closed')); }
    pending.clear();
    if (reason) onClose?.(reason);
  };
  socket.setEncoding?.('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_BYTES) return finish('line_too_large');
    let index;
    while (!closed && (index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { onNotification?.({malformed: true}); continue; }
      if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') { onNotification?.({malformed: true}); continue; }
      if (message.id !== undefined && message.id !== null && pending.has(message.id)) {
        const {resolve, reject, timer} = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(timer);
        if (message.error) reject(coreError(String(message.error?.data?.kind || message.error?.message || 'core_error'), true));
        else resolve(message.result);
      } else if (typeof message.method === 'string' && message.id === undefined) {
        onNotification?.(message);
      } else {
        onNotification?.({malformed: true});
      }
    }
  });
  socket.on('error', error => finish(error?.code === 'ENOENT' || error?.code === 'ECONNREFUSED' ? 'not_running' : 'socket_error'));
  socket.on('close', () => finish('closed'));
  return {
    request(method, params = {}, {timeout = timeoutMs} = {}) {
      assertRequestAllowed(methods, method, params);
      if (closed) return Promise.reject(coreError('closed'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(coreError('timeout')); finish('timeout'); }, timeout);
        pending.set(id, {resolve, reject, timer});
        socket.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
      });
    },
    close() { finish(null); },
    get closed() { return closed; },
  };
}

function terminalRecord(item, sourceKey, previous, now) {
  if (item.state !== 'live') return null;
  const status = item.reported ? normalizeCoreStatus({state: item.statusState}) : 'unknown';
  return {
    id: `hcore:${sourceKey}:${item.address}`,
    address: item.address,
    kind: item.app,
    // Generic kind plus the opaque, pattern-checked address so same-kind terminals stay distinguishable.
    name: `${item.app ? AGENT_KINDS[item.app] : 'Herdr Agent'} · ${item.address}`,
    status,
    progress: status === 'working' || status === 'blocked' ? item.progress : null,
    reported: item.reported,
    statusChangedAt: previous && previous.status === status ? previous.statusChangedAt : now,
  };
}

export class HerdrCoreStatusSource {
  constructor({socketPath = resolveCoreSocketPath(), connect = net.createConnection, now = () => Date.now(), reconnectDelays = RECONNECT_DELAYS_MS, staleAfterMs = STALE_AFTER_MS, requestTimeoutMs = REQUEST_TIMEOUT_MS, sendTimeoutMs = SEND_TIMEOUT_MS, label = 'Herdr Core', labels = DEFAULT_LABEL_FILTER} = {}) {
    if (!labels || typeof labels !== 'object' || !Object.keys(labels).length || !Object.values(labels).every(value => typeof value === 'string' && value)) throw new Error('A Herdr Core label filter is required');
    Object.assign(this, {socketPath, connect, now, reconnectDelays, staleAfterMs, requestTimeoutMs, sendTimeoutMs, label});
    this.labels = Object.freeze({...labels});
    this.sourceKey = coreSourceKey(socketPath);
    this.raw = new Map();
    this.terminals = new Map();
    this.connection = 'stopped';
    this.reason = '';
    this.generationReported = null;
    this.seq = 0;
    this.updatedAt = null;
    this.lastMessageAt = 0;
    this.running = false;
    this.epoch = 0;
    this.attempt = 0;
    this.conn = null;
    this.timers = new Set();
    this.watchdog = null;
    this.sending = new Set();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.connectOnce();
  }

  stop() {
    this.running = false;
    this.epoch += 1;
    this.conn?.close(); this.conn = null;
    clearInterval(this.watchdog); this.watchdog = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.connection = 'stopped';
  }

  later(fn, ms) {
    const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms);
    this.timers.add(timer);
  }

  async connectOnce() {
    const epoch = ++this.epoch;
    this.connection = 'connecting';
    // Notifications that arrive before the subscription snapshot is installed are replayed after it, in order.
    const pending = [];
    this.pending = pending;
    let conn;
    try {
      conn = openCoreConnection(this.connect, this.socketPath, {
        timeoutMs: this.requestTimeoutMs,
        onNotification: message => epoch === this.epoch && this.handleNotification(message),
        onClose: reason => epoch === this.epoch && this.goOffline(reason),
      });
      this.conn = conn;
      const hello = await conn.request('hello', {generation: CORE_GENERATION});
      if (epoch !== this.epoch) return conn.close();
      if (!hello || hello.generation !== CORE_GENERATION) throw coreError('unsupported_generation');
      if (Array.isArray(hello.methods) && !hello.methods.includes('events.subscribe')) throw coreError('events_unsupported');
      this.generationReported = hello.generation;
      // Plain mode: after this reply the connection carries only notifications.
      const snapshot = await conn.request('events.subscribe', {labels: {...this.labels}});
      if (epoch !== this.epoch) return conn.close();
      if (!snapshot || !Array.isArray(snapshot.terminals) || !Number.isInteger(snapshot.seq)) throw coreError('bad_snapshot');
      this.applySnapshot(snapshot.seq, snapshot.terminals);
      this.connection = 'connected';
      this.reason = '';
      this.attempt = 0;
      this.lastMessageAt = this.now();
      this.armWatchdog(epoch);
      this.pending = null;
      for (const message of pending) {
        if (epoch !== this.epoch) break;
        this.handleNotification(message);
      }
    } catch (error) {
      if (epoch === this.epoch) this.goOffline(error?.code || 'connect_failed');
      else conn?.close();
    }
  }

  armWatchdog(epoch) {
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (epoch !== this.epoch) return clearInterval(this.watchdog);
      if (this.now() - this.lastMessageAt > this.staleAfterMs) this.goOffline('stale');
    }, Math.max(20, Math.floor(this.staleAfterMs / 3)));
    this.watchdog.unref?.();
  }

  // Reconnecting takes a fresh snapshot; Core's seq restarts with each core process.
  resync(reason) {
    if (!this.running) return;
    this.epoch += 1;
    this.conn?.close(); this.conn = null;
    this.reason = reason;
    this.connectOnce();
  }

  goOffline(reason) {
    if (!this.running) return;
    this.epoch += 1;
    this.conn?.close(); this.conn = null;
    clearInterval(this.watchdog); this.watchdog = null;
    this.connection = 'offline';
    this.reason = String(reason || 'disconnected');
    const delay = this.reconnectDelays[Math.min(this.attempt, this.reconnectDelays.length - 1)];
    this.attempt += 1;
    const epoch = this.epoch;
    this.later(() => { if (this.running && epoch === this.epoch) this.connectOnce(); }, delay);
  }

  handleNotification(message) {
    this.lastMessageAt = this.now();
    if (message?.malformed) return;
    if (this.connection !== 'connected') {
      if (this.connection === 'connecting' && this.pending && this.pending.length < MAX_PENDING_NOTIFICATIONS) this.pending.push(message);
      return;
    }
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    if (message.method === 'heartbeat') {
      // seq is core-wide; with a label filter, events for other terminals advance it without reaching us.
      if (Number.isInteger(params.seq) && params.seq > this.seq) this.seq = params.seq;
      return;
    }
    if (message.method === 'missed') {
      if (Number.isInteger(params.seq) && Array.isArray(params.terminals)) this.applySnapshot(params.seq, params.terminals);
      else this.resync('bad_missed');
      return;
    }
    if (message.method !== 'event' || !Number.isInteger(params.seq)) return;
    // Gaps are normal under a filter; Core reports real loss with `missed`.
    if (params.seq <= this.seq) return;
    this.seq = params.seq;
    this.applyEvent(params);
  }

  applySnapshot(seq, terminals) {
    this.seq = seq;
    this.raw = new Map();
    for (const raw of terminals.slice(0, MAX_TERMINALS * 2)) {
      const item = projectTerminal(raw, this.labels);
      if (item) this.raw.set(item.address, item);
    }
    this.rebuild();
  }

  applyEvent({type, terminal, data}) {
    if (typeof terminal !== 'string') return;
    const current = this.raw.get(terminal);
    const value = data && typeof data === 'object' ? data : {};
    if (type === 'created' || type === 'restarted') {
      const item = value.address === terminal ? projectTerminal(value, this.labels) : null;
      if (item) this.raw.set(terminal, item);
      else this.raw.delete(terminal);
    } else if (type === 'removed') {
      this.raw.delete(terminal);
    } else if (type === 'labels') {
      // A terminal that stops matching the repo filter leaves the view; a new match arrives as `record`.
      if (!matchesLabels(value.labels, this.labels)) this.raw.delete(terminal);
      else if (!current && value.record?.address === terminal) {
        const item = projectTerminal(value.record, this.labels);
        if (item) this.raw.set(terminal, item);
      } else return;
    } else if (!current) {
      return;
    } else if (type === 'status') {
      this.raw.set(terminal, {...current, ...projectStatus(value.status), reported: value.reported === true});
    } else if (type === 'finished') {
      this.raw.set(terminal, {...current, state: 'finished', ...projectStatus(null)});
    } else if (type === 'lost') {
      // A kept terminal stays live without a program; its old status no longer applies.
      this.raw.set(terminal, {...current, ...projectStatus(null)});
    } else {
      // title, turn, size, foreground and keep are never read; they cannot change status.
      return;
    }
    this.rebuild();
  }

  rebuild() {
    const now = this.now(), next = new Map();
    for (const raw of this.raw.values()) {
      if (next.size >= MAX_TERMINALS) break;
      const id = `hcore:${this.sourceKey}:${raw.address}`;
      const record = terminalRecord(raw, this.sourceKey, this.terminals.get(id), now);
      if (record) next.set(record.id, record);
    }
    this.terminals = next;
    this.updatedAt = now;
  }

  // One explicit user message to one listed agent. Returns {outcome, reason?, status?, started?}:
  // `rejected` means nothing was sent; `refused` means Core declined to type; `uncertain` means the
  // text may or may not have been typed. Nothing here retries; the caller must not retry either.
  async sendMessage(address, text) {
    const listed = typeof address === 'string' && ADDRESS_PATTERN.test(address) ? this.terminals.get(`hcore:${this.sourceKey}:${address}`) : null;
    if (!listed) return {outcome: 'rejected', reason: 'unknown_target'};
    if (!validMessageText(text)) return {outcome: 'rejected', reason: 'invalid_text'};
    if (this.connection !== 'connected' || this.now() - this.lastMessageAt > this.staleAfterMs) return {outcome: 'rejected', reason: 'source_offline'};
    if (listed.status === 'blocked') return {outcome: 'rejected', reason: 'blocked'};
    if (!SENDABLE_STATES.includes(listed.status)) return {outcome: 'rejected', reason: 'not_sendable_status'};
    if (!listed.kind) return {outcome: 'rejected', reason: 'unknown_app'};
    if (this.sending.has(address)) return {outcome: 'rejected', reason: 'send_in_progress'};
    this.sending.add(address);
    let conn = null, typed = false;
    try {
      conn = openCoreConnection(this.connect, this.socketPath, {methods: SEND_METHODS, timeoutMs: this.requestTimeoutMs});
      const hello = await conn.request('hello', {generation: CORE_GENERATION});
      if (!hello || hello.generation !== CORE_GENERATION) return {outcome: 'rejected', reason: 'unsupported_generation'};
      if (Array.isArray(hello.methods) && !['terminal.get', 'terminal.send'].every(method => hello.methods.includes(method))) return {outcome: 'rejected', reason: 'send_unsupported'};
      // Refresh identity and state right before typing; only derived values survive this line.
      const fresh = projectSendTarget(await conn.request('terminal.get', {terminal: address}), this.labels);
      const refusal = sendTargetRefusal(fresh, listed);
      if (refusal) return {outcome: 'rejected', reason: refusal};
      typed = true;
      // No `force`, so Core refuses a blocked program; `if` makes Core refuse unless the status is still exactly this word.
      const result = await conn.request('terminal.send', {terminal: address, text, if: fresh.statusState}, {timeout: this.sendTimeoutMs});
      return {
        outcome: 'submitted',
        status: typeof result?.status === 'string' ? normalizeCoreStatus({state: result.status}) : 'unknown',
        started: result?.started === true ? true : result?.started === false ? false : null,
      };
    } catch (error) {
      if (!typed) return {outcome: 'rejected', reason: error?.fromCore && error.code === 'not_found' ? 'target_changed' : 'core_unavailable'};
      if (error?.fromCore && SEND_REFUSALS.has(error.code)) return {outcome: 'refused', reason: error.code};
      return {outcome: 'uncertain', reason: error?.code === 'timeout' ? 'timeout' : error?.fromCore ? 'core_uncertain' : 'connection_lost'};
    } finally {
      conn?.close();
      this.sending.delete(address);
    }
  }

  publicState() {
    return {
      source: 'HerdrCore',
      sourceKey: this.sourceKey,
      label: this.label,
      connection: this.connection,
      reason: this.reason,
      generation: this.generationReported,
      updatedAt: this.updatedAt ? new Date(this.updatedAt).toISOString() : null,
      agents: [...this.terminals.values()].map(item => ({...item, statusChangedAt: new Date(item.statusChangedAt).toISOString()})),
    };
  }
}

export function agentStatusDisabled(env = process.env) {
  return env.VITE_PUBLIC_DEMO === 'true' || env.AI_OFFICE_HERDR_CORE_STATUS === 'off';
}

// Starts sources lazily on the first poll and stops them after polling goes quiet.
export function createAgentStatusService({sources = [new HerdrCoreStatusSource()], now = () => Date.now(), idleStopMs = IDLE_STOP_MS} = {}) {
  let lastPoll = 0, idleTimer = null;
  const armIdleStop = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (now() - lastPoll >= idleStopMs) sources.forEach(source => source.stop());
      else armIdleStop();
    }, idleStopMs);
    idleTimer.unref?.();
  };
  return {
    poll() {
      lastPoll = now();
      sources.forEach(source => source.start());
      armIdleStop();
      return {sources: sources.map(source => source.publicState())};
    },
    async send({sourceKey, address, text}) {
      const source = sources.find(item => item.sourceKey === sourceKey);
      if (!source?.sendMessage) return {outcome: 'rejected', reason: 'unknown_target'};
      return source.sendMessage(address, text);
    },
    stop() { clearTimeout(idleTimer); sources.forEach(source => source.stop()); },
  };
}

function send(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(value));
}

const MESSAGE_STATUS = {submitted: 200, rejected: 409, refused: 409, uncertain: 504};
const SOURCE_KEY_PATTERN = /^c[0-9a-f]{10}$/;

// The message route shares the status route's loopback, host, origin and fetch-site rules, and additionally
// requires POST, a same-origin Origin header and a small JSON body.
export function rejectMessageRequest(req) {
  if (req.method !== 'POST') return {status: 405, error: 'method_not_allowed'};
  const rejected = rejectRequest({method: 'GET', socket: req.socket, headers: req.headers});
  if (rejected) return rejected;
  if (req.headers?.origin === undefined) return {status: 403, error: 'origin_required'};
  if (!/^application\/json(\s*;\s*charset=utf-8)?$/i.test(String(req.headers?.['content-type'] || '').trim())) return {status: 415, error: 'json_required'};
  const length = Number(req.headers?.['content-length']);
  if (req.headers?.['content-length'] !== undefined && !(Number.isInteger(length) && length >= 0 && length <= MAX_MESSAGE_BODY_BYTES)) return {status: 413, error: 'body_too_large'};
  return null;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, done = false;
    req.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > limit) { done = true; reject(Object.assign(new Error('body_too_large'), {status: 413})); req.resume?.(); return; }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', () => { if (!done) { done = true; reject(Object.assign(new Error('bad_body'), {status: 400})); } });
  });
}

// Only {sourceKey, address, text}: an opaque key and address the client got from the status route, never a method.
export function parseMessageBody(text) {
  let body;
  try { body = JSON.parse(text); } catch { return null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (Object.keys(body).sort().join(',') !== 'address,sourceKey,text') return null;
  if (typeof body.sourceKey !== 'string' || !SOURCE_KEY_PATTERN.test(body.sourceKey)) return null;
  if (typeof body.address !== 'string' || !ADDRESS_PATTERN.test(body.address)) return null;
  if (!validMessageText(body.text)) return null;
  return {sourceKey: body.sourceKey, address: body.address, text: body.text};
}

async function handleMessage(req, res, service) {
  const rejected = rejectMessageRequest(req);
  if (rejected) {
    if (rejected.status === 405) res.setHeader('Allow', 'POST');
    return send(res, rejected.status, {delivered: false, outcome: 'rejected', reason: rejected.error});
  }
  let raw;
  try { raw = await readBody(req, MAX_MESSAGE_BODY_BYTES); } catch (error) {
    return send(res, error.status || 400, {delivered: false, outcome: 'rejected', reason: error.message});
  }
  const message = parseMessageBody(raw);
  if (!message) return send(res, 400, {delivered: false, outcome: 'rejected', reason: 'invalid_message'});
  let result;
  try { result = await service.send(message); } catch { result = {outcome: 'uncertain', reason: 'internal_error'}; }
  const status = result.outcome === 'rejected' && result.reason === 'unknown_target' ? 404 : MESSAGE_STATUS[result.outcome] || 504;
  return send(res, status, {delivered: result.outcome === 'submitted', ...result});
}

export function createAgentStatusHandler({env = process.env, service} = {}) {
  let current = service;
  return function handle(req, res, next) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== AGENT_STATUS_PATH && url.pathname !== AGENT_MESSAGE_PATH) return next();
    if (agentStatusDisabled(env)) return send(res, 404, {available: false, error: 'disabled'});
    if (url.pathname === AGENT_MESSAGE_PATH) {
      current ||= createAgentStatusService();
      return handleMessage(req, res, current);
    }
    const rejected = rejectRequest(req);
    if (rejected) {
      if (rejected.status === 405) res.setHeader('Allow', 'GET');
      return send(res, rejected.status, {available: false, error: rejected.error});
    }
    current ||= createAgentStatusService();
    return send(res, 200, {available: true, ...current.poll()});
  };
}

export function agentStatusPlugin() {
  return {
    name: 'ai-office-agent-status',
    configureServer(server) {
      server.middlewares.use(createAgentStatusHandler());
    },
  };
}
