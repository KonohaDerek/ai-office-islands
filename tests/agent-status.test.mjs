import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  ALLOWED_METHODS, AGENT_STATUS_PATH, DEFAULT_LABEL_FILTER, HerdrCoreStatusSource, RETAINED_FIELDS, agentKind, coreSourceKey,
  createAgentStatusHandler, createAgentStatusService, normalizeCoreStatus, openCoreConnection, projectTerminal, resolveCoreSocketPath,
} from '../server/herdr-core-status.mjs';
import {AGENT_STATUS_LEGEND, AGENT_STATUS_META, coreAgentState, coreMapBots, resolveAgentStatus} from '../src/agent-status-utils.mjs';
import {REPO_LABELS, companyTerminal, startFakeCore, terminal} from './fake-herdr-core-socket.mjs';

const READ_ONLY = new Set(['hello', 'events.subscribe']);
// Text that only appears in discarded fields of the fake records (names, titles, argv, cwd, foreground, labels, status text).
const SECRETS = ['secret', 'busy.js', 'cargo', '80%', '/Users/someone', 'acme', 'Acme', 'payroll', 'ai-office-islands', 'working hard'];
const PUBLIC_FIELDS = ['address', 'id', 'kind', 'name', 'progress', 'reported', 'status', 'statusChangedAt'];

async function until(check, {timeoutMs = 3_000, label = 'condition'} = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function source(fake, options = {}) {
  return new HerdrCoreStatusSource({socketPath: fake.socketPath, reconnectDelays: [30], staleAfterMs: 60_000, requestTimeoutMs: 1_000, ...options});
}
const statusOf = (src, address) => src.publicState().agents.find(item => item.address === address)?.status;
const connected = src => until(() => src.publicState().connection === 'connected', {label: 'connected'});
const onlyReadOnly = fake => assert.ok(fake.state.methods.every(method => READ_ONLY.has(method)), fake.state.methods.join(','));
const subscribeCount = fake => fake.state.methods.filter(method => method === 'events.subscribe').length;

// Every cached record holds only allowlisted keys, and nothing discarded survives anywhere in the source.
function assertRetainedSafe(src) {
  for (const item of src.raw.values()) assert.deepEqual(Object.keys(item).sort(), [...RETAINED_FIELDS].sort());
  for (const item of src.publicState().agents) assert.deepEqual(Object.keys(item).sort(), PUBLIC_FIELDS);
  const dump = JSON.stringify({raw: [...src.raw.values()], terminals: [...src.terminals.values()], state: src.publicState()});
  for (const secret of SECRETS) assert.equal(dump.includes(secret), false, secret);
  assert.equal(dump.includes(src.socketPath), false, 'socket path');
}

test('maps exactly the Core status words and nothing else', () => {
  for (const state of ['idle', 'working', 'blocked', 'done', 'error']) assert.equal(normalizeCoreStatus({state}), state);
  for (const value of [null, undefined, {}, {state: 'thinking'}, {state: 'WORKING'}, {state: 3}, 'working']) assert.equal(normalizeCoreStatus(value), 'unknown');
  assert.equal(coreAgentState('error'), 'error');
  assert.equal(coreAgentState('review'), 'unknown');
});

test('labels and legend use the approved wording, with a distinct error state', () => {
  assert.deepEqual(Object.fromEntries(AGENT_STATUS_LEGEND.map(key => [key, AGENT_STATUS_META[key].label])), {
    working: '工作中', idle: '閒置', blocked: '等待協助', done: '已完成', error: '錯誤', unknown: '狀態未知', offline: '來源離線',
  });
  assert.notEqual(AGENT_STATUS_META.error.tone, AGENT_STATUS_META.offline.tone);
});

test('only generic agent kinds survive from status.app', () => {
  assert.equal(agentKind('claude'), 'claude');
  assert.equal(agentKind(' Codex '), 'codex');
  for (const value of ['acme-billing-bot', 'claude: fixing payroll', '', null, 7, 'constructor', '__proto__', 'toString']) assert.equal(agentKind(value), '', String(value));
});

test('ingress projection keeps only allowlisted fields and rejects non-matching labels', () => {
  const item = projectTerminal(terminal('t1', 'working', {status: {state: 'working', app: 'claude', progress: 40, msg: 'secret', title: 'secret'}}));
  assert.deepEqual(item, {address: 't1', state: 'live', statusState: 'working', progress: 40, app: 'claude', reported: true});
  assert.deepEqual(Object.keys(item).sort(), [...RETAINED_FIELDS].sort());
  assert.equal(projectTerminal(terminal('t2', 'thinking')).statusState, 'unrecognized');
  assert.equal(projectTerminal(terminal('t3', 'idle', {status: {state: 'idle', app: 'acme-corp-agent'}})).app, '');
  assert.equal(projectTerminal(companyTerminal()), null);
  assert.equal(projectTerminal({...terminal('t4', 'idle'), labels: {}}), null);
  assert.equal(projectTerminal({...terminal('t5', 'idle'), labels: undefined}), null);
  assert.equal(projectTerminal(terminal('rohan/t1', 'idle')), null);
});

test('the status connection refuses every method except hello and events.subscribe before it reaches the socket', () => {
  assert.deepEqual([...ALLOWED_METHODS].sort(), ['events.subscribe', 'hello', 'terminal.get', 'terminal.send']);
  const written = [];
  const fakeSocket = new net.Socket();
  fakeSocket.write = line => { written.push(line); return true; };
  const conn = openCoreConnection(() => fakeSocket, '/unused', {});
  for (const method of ['terminal.list', 'terminal.get', 'terminal.read', 'terminal.attach', 'terminal.send', 'terminal.keys', 'terminal.kill', 'terminal.run', 'terminal.interrupt', 'terminal.put', 'machine.exec', 'doc.get', 'doc.set', 'file.read', 'file.write', 'server.stop', 'agent.list', 'session.snapshot']) {
    assert.throws(() => conn.request(method), /not allowed/, method);
  }
  assert.deepEqual(written, []);
  conn.close();
});

test('a source cannot be created without a repo label filter', () => {
  assert.deepEqual(DEFAULT_LABEL_FILTER, {repo: 'ai-office-islands'});
  for (const labels of [{}, null, {repo: ''}, {repo: 3}]) assert.throws(() => new HerdrCoreStatusSource({socketPath: '/unused', labels}), /label filter/);
});

test('resolves the Core endpoint by the documented rules and never the Herdr TUI socket', async t => {
  const home = await mkdtemp(join(tmpdir(), 'aio-home-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const none = () => false;
  assert.equal(resolveCoreSocketPath({env: {HC_SOCKET: '/s/custom.sock'}, home, uid: 501, exists: none}), '/s/custom.sock');
  assert.equal(resolveCoreSocketPath({env: {}, home, uid: 501, exists: none}), join(home, '.local/state/herdr-core/default/default.sock'));
  assert.equal(resolveCoreSocketPath({env: {HC_SESSION: 'scratch'}, home, uid: 501, exists: none}), join(home, '.local/state/herdr-core/scratch/scratch.sock'));
  assert.equal(resolveCoreSocketPath({env: {HC_SESSION: '../x'}, home, uid: 501, exists: none}), join(home, '.local/state/herdr-core/default/default.sock'));
  assert.equal(resolveCoreSocketPath({env: {XDG_STATE_HOME: '/st'}, home, uid: 501, exists: none}), '/st/herdr-core/default/default.sock');
  assert.equal(resolveCoreSocketPath({env: {}, home, uid: 501, exists: path => path === '/run/user/501'}), '/run/user/501/herdr-core/default.sock');
  assert.equal(resolveCoreSocketPath({env: {XDG_RUNTIME_DIR: '/rt'}, home, uid: 501, exists: () => true}), '/rt/herdr-core/default.sock');
  await mkdir(join(home, '.config', 'herdr-core'), {recursive: true});
  await writeFile(join(home, '.config', 'herdr-core', 'config.toml'), 'notes = false\nsocket = "~/hc.sock"\n[other]\nsocket = "/ignored.sock"\n');
  assert.equal(resolveCoreSocketPath({env: {XDG_RUNTIME_DIR: '/rt'}, home, uid: 501, exists: none}), join(home, 'hc.sock'));
  assert.equal(resolveCoreSocketPath({env: {HC_SOCKET: '/s/env.sock'}, home, uid: 501, exists: none}), '/s/env.sock');
  for (const env of [{}, {XDG_RUNTIME_DIR: '/rt'}, {HC_SESSION: 'x'}]) assert.equal(resolveCoreSocketPath({env, home: '/h', uid: 1, exists: none}).includes('herdr.sock'), false);
});

test('subscribes only with the repo label filter and keeps company-like terminals out of state', async t => {
  const fake = await startFakeCore({terminals: [
    terminal('t1', 'working'), terminal('t2', 'idle', {status: {state: 'idle', app: 'codex', msg: 'secret'}}), terminal('t3', 'blocked'),
    terminal('t4', 'done'), terminal('t5', 'error'), terminal('t6', null), terminal('t7', 'thinking'),
    terminal('t8', 'working', {state: 'finished'}), terminal('rohan/t1', 'working'),
    {...terminal('t9', null), title: 'working… 80%', foreground: {pid: 1, name: 'cargo', argv: ['cargo', 'build'], cwd: '/x'}},
    companyTerminal('t99'),
  ]});
  const src = source(fake);
  t.after(async () => { src.stop(); await fake.close(); });
  src.start();
  await connected(src);
  assert.deepEqual(fake.state.subscribeParams, [{labels: REPO_LABELS}]);
  const state = src.publicState();
  assert.equal(state.generation, 1);
  assert.deepEqual(state.agents.map(item => [item.address, item.status]), [['t1', 'working'], ['t2', 'idle'], ['t3', 'blocked'], ['t4', 'done'], ['t5', 'error'], ['t6', 'unknown'], ['t7', 'unknown'], ['t9', 'unknown']]);
  assert.deepEqual(state.agents.map(item => item.name), ['Claude Code · t1', 'Codex · t2', 'Claude Code · t3', 'Claude Code · t4', 'Claude Code · t5', 'Herdr Agent · t6', 'Claude Code · t7', 'Herdr Agent · t9']);
  assert.equal(src.raw.has('t99'), false);
  assertRetainedSafe(src);
  onlyReadOnly(fake);
});

test('same-kind terminals get distinct neutral names built only from kind and address', async t => {
  const raw = {name: 'acme-payroll-fix', title: 'Acme payroll export', labels: {...REPO_LABELS, client: 'Acme Corp'}, cwd: '/Users/someone/acme', argv: ['claude', '--acme'],
    status: {state: 'working', app: 'claude', msg: 'Acme confidential', title: 'secret status title'}};
  const fake = await startFakeCore({terminals: [
    terminal('t101', 'working', raw), terminal('t102', 'idle', {...raw, name: 'other-secret-task', status: {...raw.status, state: 'idle'}}),
    terminal('t103', 'working', {...raw, status: {state: 'working', app: 'acme-internal-bot', msg: 'Acme'}}),
  ]});
  const src = source(fake);
  t.after(async () => { src.stop(); await fake.close(); });
  src.start();
  await connected(src);
  const names = src.publicState().agents.map(item => item.name);
  assert.deepEqual(names, ['Claude Code · t101', 'Claude Code · t102', 'Herdr Agent · t103']);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /^(Claude Code|Codex|Hermes|Gemini CLI|Aider|OpenCode|Goose|Amp|Herdr Agent) · t[0-9A-Za-z]+$/);
  const bots = coreMapBots([src.publicState()], [[[10, 10], [20, 20], [30, 30]]]);
  assert.deepEqual(bots.map(bot => bot.name), names);
  assertRetainedSafe(src);
});

test('created and status events are projected immediately; foreign events never enter', async t => {
  const fake = await startFakeCore({terminals: [terminal('t1', null)]});
  const src = source(fake);
  t.after(async () => { src.stop(); await fake.close(); });
  src.start();
  await connected(src);
  fake.state.terminals.push(terminal('t2', 'working'));
  fake.event('created', 't2', terminal('t2', 'working', {status: {state: 'working', app: 'hermes', msg: 'secret created message', progress: 30}}));
  await until(() => statusOf(src, 't2') === 'working', {label: 'created'});
  assert.equal(src.publicState().agents.find(item => item.address === 't2').progress, 30);
  assertRetainedSafe(src);
  fake.state.terminals.push(companyTerminal('t50'));
  fake.event('created', 't50', companyTerminal('t50'));
  fake.event('status', 't1', {status: {state: 'blocked', app: 'claude', msg: 'secret status message', title: 'secret status title'}, records: {x: {state: 'working', msg: 'secret record'}}, reported: true});
  await until(() => statusOf(src, 't1') === 'blocked', {label: 'status'});
  assert.equal(src.raw.has('t50'), false);
  assertRetainedSafe(src);
  // A created event that slips past the server-side filter is still rejected at ingress.
  fake.state.seq += 1;
  fake.raw(JSON.stringify({jsonrpc: '2.0', method: 'event', params: {seq: fake.state.seq, type: 'created', terminal: 't98', data: companyTerminal('t98')}}) + '\n');
  await until(() => src.seq === fake.state.seq, {label: 'consumed'});
  assert.equal(src.raw.has('t98'), false);
  assertRetainedSafe(src);
});

test('a terminal whose labels stop matching the repo filter leaves the view', async t => {
  const fake = await startFakeCore({terminals: [terminal('t1', 'working'), terminal('t2', 'idle')]});
  const src = source(fake);
  t.after(async () => { src.stop(); await fake.close(); });
  src.start();
  await connected(src);
  fake.event('labels', 't2', {labels: {repo: 'acme-corp-internal'}});
  await until(() => !src.raw.has('t2'), {label: 'left view'});
  assert.deepEqual(src.publicState().agents.map(item => item.address), ['t1']);
  assertRetainedSafe(src);
});

test('status events update in place; title, foreground and turn events never change status', async t => {
  const fake = await startFakeCore({terminals: [terminal('t1', 'working'), terminal('t2', null)]});
  const src = source(fake);
  t.after(async () => { src.stop(); await fake.close(); });
  src.start();
  await connected(src);
  for (const next of ['idle', 'blocked', 'done', 'error', 'working']) {
    fake.setStatus('t1', next);
    await until(() => statusOf(src, 't1') === next, {label: next});
  }
  fake.setStatus('t1', null, {reported: true});
  await until(() => statusOf(src, 't1') === 'unknown', {label: 'cleared'});
  fake.event('title', 't2', {title: 'working hard'});
  fake.event('foreground', 't2', {pid: 2, name: 'npm', argv: ['npm', 'test'], cwd: '/x'});
  fake.event('turn', 't2', {turn: 3, state: 'done'});
  fake.event('size', 't2', {cols: 100, rows: 40});
  await until(() => src.seq === fake.state.seq, {label: 'events consumed'});
  assert.equal(statusOf(src, 't2'), 'unknown');
  assertRetainedSafe(src);
  onlyReadOnly(fake);
});

test('created, finished, lost and removed events follow the Core apply rules', async t => {
  const fake = await startFakeCore({terminals: [terminal('t1', 'working')]});
  const src = source(fake);
  t.after(async () => { src.stop(); await fake.close(); });
  src.start();
  await connected(src);
  fake.state.terminals.push(terminal('t2', 'idle'));
  fake.event('created', 't2', terminal('t2', 'idle'));
  await until(() => statusOf(src, 't2') === 'idle', {label: 'created'});
  fake.event('lost', 't2', {reason: 'signaled', exit_code: null, signal: 9, finished_ms: null});
  await until(() => statusOf(src, 't2') === 'unknown', {label: 'lost clears status'});
  fake.event('finished', 't1', {reason: 'exited', exit_code: 0, signal: null, finished_ms: 2});
  await until(() => !statusOf(src, 't1'), {label: 'finished leaves view'});
  fake.event('removed', 't2', {});
  await until(() => src.publicState().agents.length === 0, {label: 'removed'});
});

test('filtered seq gaps and heartbeats are normal; missed replaces the snapshot; stale events are ignored', async t => {
  const fake = await startFakeCore({terminals: [terminal('t1', 'working'), companyTerminal('t99')]});
  const src = source(fake);
  t.after(async () => { src.stop(); await fake.close(); });
  src.start();
  await connected(src);
  fake.event('status', 't99', {status: {state: 'idle'}, records: {}, reported: true});
  fake.event('title', 't99', {title: 'Acme Corp'});
  fake.setStatus('t1', 'idle');
  await until(() => statusOf(src, 't1') === 'idle', {label: 'event after filtered gap'});
  fake.state.seq += 4;
  fake.heartbeat();
  await until(() => src.seq === fake.state.seq, {label: 'heartbeat advances seq'});
  assert.equal(subscribeCount(fake), 1, 'no resubscribe for normal filtered gaps');
  fake.state.terminals = [terminal('t1', 'done'), terminal('t3', 'blocked'), companyTerminal('t99')];
  fake.missed();
  await until(() => statusOf(src, 't1') === 'done' && statusOf(src, 't3') === 'blocked', {label: 'missed snapshot'});
  fake.raw(JSON.stringify({jsonrpc: '2.0', method: 'event', params: {seq: src.seq - 1, type: 'status', terminal: 't1', data: {status: {state: 'error'}, records: {}, reported: true}}}) + '\n');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(statusOf(src, 't1'), 'done');
  assert.equal(src.raw.has('t99'), false);
  assertRetainedSafe(src);
});

test('malformed lines and unknown notifications never fabricate status', async t => {
  const fake = await startFakeCore({terminals: [terminal('t1', null)]});
  const src = source(fake);
  t.after(async () => { src.stop(); await fake.close(); });
  src.start();
  await connected(src);
  fake.raw('{not json\n');
  fake.raw(JSON.stringify({method: 'event', params: {seq: 999, type: 'status', terminal: 't1', data: {status: {state: 'working'}}}}) + '\n');
  fake.raw(JSON.stringify({jsonrpc: '2.0', method: 'surprise', params: {seq: 1}}) + '\n');
  fake.event('status', 't1', {status: {state: 'busy'}, records: {}, reported: true});
  await until(() => src.seq === fake.state.seq, {label: 'consumed'});
  assert.equal(src.publicState().connection, 'connected');
  assert.deepEqual(src.publicState().agents.map(item => [item.address, item.status]), [['t1', 'unknown']]);
});

test('a disconnected core shows 來源離線 instead of the last state, then recovers with a fresh filtered snapshot', async t => {
  let fake = await startFakeCore({terminals: [terminal('t1', 'working')]});
  const src = source(fake, {reconnectDelays: [40]});
  t.after(async () => { src.stop(); await fake.close(); });
  src.start();
  await connected(src);
  await fake.close({keepDir: true});
  await until(() => src.publicState().connection === 'offline', {label: 'offline'});
  const offline = src.publicState();
  const bot = coreMapBots([offline], [[[10, 10]]])[0];
  assert.deepEqual(resolveAgentStatus(bot, {coreSources: [offline]}).label, '來源離線');
  fake = await fake.restart();
  fake.state.terminals = [terminal('t1', 'idle'), companyTerminal('t99')];
  await until(() => src.publicState().connection === 'connected' && statusOf(src, 't1') === 'idle', {label: 'reconnected'});
  assert.deepEqual(fake.state.subscribeParams, [{labels: REPO_LABELS}]);
  assertRetainedSafe(src);
});

test('a silent stream goes stale and offline', async t => {
  const fake = await startFakeCore({terminals: [terminal('t1', 'working')]});
  const src = source(fake, {staleAfterMs: 60, reconnectDelays: [10_000]});
  t.after(async () => { src.stop(); await fake.close(); });
  src.start();
  await connected(src);
  await until(() => src.publicState().connection === 'offline', {label: 'stale'});
  assert.equal(src.publicState().reason, 'stale');
});

test('an unsupported protocol generation or a missing socket stays offline', async t => {
  const fake = await startFakeCore({generation: 2});
  const src = source(fake, {reconnectDelays: [10_000]});
  const missing = new HerdrCoreStatusSource({socketPath: '/nonexistent/aio-hc.sock', reconnectDelays: [10_000]});
  t.after(async () => { src.stop(); missing.stop(); await fake.close(); });
  src.start(); missing.start();
  await until(() => src.publicState().connection === 'offline' && missing.publicState().connection === 'offline', {label: 'offline'});
  assert.equal(src.publicState().reason, 'unsupported_generation');
  assert.equal(missing.publicState().reason, 'not_running');
  assert.deepEqual(missing.publicState().agents, []);
});

test('identical terminal addresses on distinct cores stay distinct', async t => {
  const a = await startFakeCore({terminals: [terminal('t1', 'working')]});
  const b = await startFakeCore({terminals: [terminal('t1', 'idle')]});
  const srcA = source(a), srcB = source(b);
  t.after(async () => { srcA.stop(); srcB.stop(); await a.close(); await b.close(); });
  srcA.start(); srcB.start();
  await connected(srcA); await connected(srcB);
  const sources = [srcA.publicState(), srcB.publicState()];
  assert.notEqual(coreSourceKey(a.socketPath), coreSourceKey(b.socketPath));
  const bots = coreMapBots(sources, [[[10, 10], [20, 20]]]);
  assert.equal(new Set(bots.map(item => item.id)).size, 2);
  assert.deepEqual(bots.map(item => resolveAgentStatus(item, {coreSources: sources}).state), ['working', 'idle']);
});

test('roster, history and unsupported sources never receive fabricated activity', () => {
  const providers = {Hermes: {connected: true}, Grok: {connected: false}};
  assert.equal(resolveAgentStatus({id: 'future', status: '研究中'}, {}).state, 'unknown');
  assert.equal(resolveAgentStatus({id: 'c', source: 'CodexCLI', codexReadOnly: true}, {activeRequests: {c: 1}}).state, 'unknown');
  assert.equal(resolveAgentStatus({id: 'h', source: 'Hermes'}, {providers, activeSource: 'Hermes'}).state, 'unknown');
  assert.equal(resolveAgentStatus({id: 'h', source: 'Hermes'}, {providers, activeSource: 'Hermes', activeRequests: {h: 1}}).state, 'working');
  assert.equal(resolveAgentStatus({id: 'g', runtimeSource: 'Grok'}, {providers}).state, 'offline');
  assert.equal(resolveAgentStatus({id: 'g', runtimeSource: 'Grok'}, {providers, sourcesLoading: true}).state, 'unknown');
  const bot = {id: 'hcore:cx:t1', source: 'HerdrCore', coreSourceKey: 'cx'};
  const withAgents = agents => ({coreSources: [{sourceKey: 'cx', connection: 'connected', agents}]});
  assert.equal(resolveAgentStatus(bot, {coreSources: [{sourceKey: 'cx', connection: 'connecting', agents: []}]}).state, 'unknown');
  assert.equal(resolveAgentStatus(bot, withAgents([])).state, 'unknown');
  assert.equal(resolveAgentStatus(bot, {coreSources: []}).state, 'offline');
  assert.equal(resolveAgentStatus(bot, withAgents([{id: bot.id, status: 'error', reported: true}])).label, '錯誤');
  assert.equal(resolveAgentStatus(bot, withAgents([{id: bot.id, status: 'unknown', reported: false}])).label, '狀態未知');
  assert.equal(resolveAgentStatus(bot, {...withAgents([{id: bot.id, status: 'idle'}]), activeRequests: {[bot.id]: 1}}).label, '閒置');
});

test('map placement uses only neutral names and spreads terminals across every walkable route', () => {
  const routes = [[[1, 1], [2, 2], [3, 3], [4, 4]], [[50, 50], [60, 60], [70, 70], [80, 80]]];
  const agents = ['t1', 't2', 't3', 't4'].map((address, index) => ({id: `hcore:cx:${address}`, address, name: index ? `Claude Code · ${address}` : '', status: 'unknown'}));
  const bots = coreMapBots([{sourceKey: 'cx', agents}], routes);
  assert.deepEqual(bots.map(bot => [bot.x, bot.y]), [[1, 1], [3, 3], [50, 50], [70, 70]]);
  assert.deepEqual(bots.map(bot => bot.name), ['Herdr Agent · t1', 'Claude Code · t2', 'Claude Code · t3', 'Claude Code · t4']);
  assert.ok(bots.every(bot => bot.coreObserved && bot.source === 'HerdrCore' && bot.role === `Herdr Core 終端 ${bot.coreAddress}`));
});

function fakeRes() {
  return {statusCode: 0, headers: {}, body: '', setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = value; }};
}
const loopbackReq = (extra = {}) => ({method: 'GET', url: AGENT_STATUS_PATH, socket: {remoteAddress: '127.0.0.1'}, headers: {host: '127.0.0.1:5173'}, ...extra});

test('HTTP output carries only the projected repo terminals', async t => {
  const fake = await startFakeCore({terminals: [terminal('t1', 'working'), companyTerminal('t99')]});
  const src = source(fake);
  const service = createAgentStatusService({sources: [src], idleStopMs: 60_000});
  t.after(async () => { service.stop(); await fake.close(); });
  const handle = createAgentStatusHandler({env: {}, service});
  handle(loopbackReq(), fakeRes(), () => {});
  await connected(src);
  const res = fakeRes();
  handle(loopbackReq(), res, () => {});
  const body = JSON.parse(res.body);
  assert.deepEqual(body.sources[0].agents.map(item => item.address), ['t1']);
  for (const secret of SECRETS) assert.equal(res.body.includes(secret), false, secret);
  assert.equal(res.body.includes('t99'), false);
});

test('status endpoint is loopback-only, GET-only, and can be disabled', () => {
  const polls = [];
  const service = {poll: () => { polls.push(1); return {sources: []}; }};
  const handle = createAgentStatusHandler({env: {}, service});
  let res = fakeRes();
  handle(loopbackReq(), res, () => assert.fail('should handle'));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {available: true, sources: []});
  for (const req of [loopbackReq({socket: {remoteAddress: '192.168.1.5'}}), loopbackReq({headers: {host: '127.0.0.1:5173', origin: 'http://evil.example'}})]) {
    res = fakeRes(); handle(req, res, () => {}); assert.equal(res.statusCode, 403);
  }
  res = fakeRes(); handle(loopbackReq({method: 'POST'}), res, () => {}); assert.equal(res.statusCode, 405);
  for (const env of [{VITE_PUBLIC_DEMO: 'true'}, {AI_OFFICE_HERDR_CORE_STATUS: 'off'}]) {
    res = fakeRes(); createAgentStatusHandler({env, service})(loopbackReq(), res, () => {}); assert.equal(res.statusCode, 404);
  }
  let passed = false;
  handle(loopbackReq({url: '/other'}), fakeRes(), () => { passed = true; });
  assert.equal(passed, true);
  assert.equal(polls.length, 1);
});

test('service starts sources on poll and stops them after polling goes quiet', async () => {
  const calls = [];
  const fakeSource = {start: () => calls.push('start'), stop: () => calls.push('stop'), publicState: () => ({source: 'HerdrCore', agents: []})};
  const service = createAgentStatusService({sources: [fakeSource], idleStopMs: 30});
  assert.deepEqual(service.poll(), {sources: [{source: 'HerdrCore', agents: []}]});
  await until(() => calls.includes('stop'), {label: 'idle stop'});
  assert.deepEqual(calls, ['start', 'stop']);
  service.stop();
});
