import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import {Readable} from 'node:stream';
import {
  AGENT_MESSAGE_PATH, HerdrCoreStatusSource, SEND_METHODS, STATUS_METHODS, createAgentStatusHandler, createAgentStatusService,
  foregroundRuntime, openCoreConnection, parseMessageBody, projectSendTarget, sendTargetRefusal, validMessageText,
} from '../server/herdr-core-status.mjs';
import {coreComposerBlock, coreDeliveryText} from '../src/agent-status-utils.mjs';
import {agentForeground, agentTerminal, companyTerminal, startFakeCore, terminal} from './fake-herdr-core-socket.mjs';

// Text that only appears in discarded fields of the fake records (names, titles, argv, cwd, foreground, labels, status text).
const SECRETS = ['secret', 'busy.js', '/Users/someone', 'acme', 'Acme', 'payroll', 'ai-office-islands', '--secret-flag'];
const SEND_KEYS = ['address', 'app', 'dialog', 'labelsMatch', 'live', 'progress', 'reported', 'runtime', 'statusState'];

async function until(check, {timeoutMs = 3_000, label = 'condition'} = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function connectedSource(t, terminals, options = {}) {
  const fake = await startFakeCore({terminals});
  const src = new HerdrCoreStatusSource({socketPath: fake.socketPath, reconnectDelays: [30], staleAfterMs: 60_000, requestTimeoutMs: 1_000, sendTimeoutMs: 1_000, ...options});
  t.after(async () => { src.stop(); await fake.close(); });
  src.start();
  await until(() => src.publicState().connection === 'connected', {label: 'connected'});
  return {fake, src};
}
// Requests the send path made, i.e. everything after the status stream's hello + events.subscribe.
const sendRequests = fake => fake.state.requests.slice(2);
const coreWrites = fake => fake.state.requests.filter(item => item.method === 'terminal.get' || item.method === 'terminal.send');
const sendCalls = fake => fake.state.requests.filter(item => item.method === 'terminal.send');
// Changes what Core reports for a terminal without emitting an event, as if the event had not arrived yet.
const changeInCore = (fake, address, change) => { fake.state.terminals = fake.state.terminals.map(item => item.address === address ? {...item, ...change} : item); };

function assertNoSecrets(value, label = 'value') {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, `${label}: ${secret}`);
}

test('happy path: hello, a fresh terminal.get, then one terminal.send with an if precondition and no force', async t => {
  const {fake, src} = await connectedSource(t, [agentTerminal('t1', 'idle'), companyTerminal('t99')]);
  const result = await src.sendMessage('t1', '請整理今天的待辦\n第二行');
  assert.deepEqual(result, {outcome: 'submitted', status: 'idle', started: true});
  assert.deepEqual(sendRequests(fake), [
    {method: 'hello', params: {generation: 1}},
    {method: 'terminal.get', params: {terminal: 't1'}},
    {method: 'terminal.send', params: {terminal: 't1', text: '請整理今天的待辦\n第二行', if: 'idle'}},
  ]);
  assert.deepEqual(fake.state.typed, [{terminal: 't1', text: '請整理今天的待辦\n第二行'}]);
  for (const {method, params} of fake.state.requests) {
    assert.ok([...STATUS_METHODS, ...SEND_METHODS].includes(method), method);
    for (const key of ['force', 'wait', 'caller', 'timeout']) assert.equal(Object.hasOwn(params || {}, key), false, `${method}.${key}`);
  }
  assertNoSecrets(result, 'result');
  assertNoSecrets({raw: [...src.raw.values()], terminals: [...src.terminals.values()], state: src.publicState()}, 'source');
  assert.equal(src.sending.size, 0);
});

test('a working agent is sent with if: working, and Core\'s started=null/false is reported as such', async t => {
  const {fake, src} = await connectedSource(t, [agentTerminal('t1', 'working')]);
  fake.state.sendResult = {started: null};
  assert.deepEqual(await src.sendMessage('t1', 'hi'), {outcome: 'submitted', status: 'working', started: null});
  fake.state.sendResult = {started: false};
  assert.deepEqual(await src.sendMessage('t1', 'hi again'), {outcome: 'submitted', status: 'working', started: false});
  assert.deepEqual(sendCalls(fake).map(item => item.params.if), ['working', 'working']);
});

test('only a currently listed repo terminal on the selected source can be targeted', async t => {
  const {fake, src} = await connectedSource(t, [agentTerminal('t1', 'idle'), companyTerminal('t99'), agentTerminal('t5', 'idle', {labels: {repo: 'other-repo'}})]);
  const service = createAgentStatusService({sources: [src], idleStopMs: 60_000});
  t.after(() => service.stop());
  for (const [request, reason] of [
    [{sourceKey: 'c0000000000', address: 't1', text: 'hi'}, 'unknown_target'],
    [{sourceKey: src.sourceKey, address: 't99', text: 'hi'}, 'unknown_target'],
    [{sourceKey: src.sourceKey, address: 't5', text: 'hi'}, 'unknown_target'],
    [{sourceKey: src.sourceKey, address: 't404', text: 'hi'}, 'unknown_target'],
    [{sourceKey: src.sourceKey, address: 'machine/t1', text: 'hi'}, 'unknown_target'],
    [{sourceKey: src.sourceKey, address: 'secret-project-name', text: 'hi'}, 'unknown_target'],
  ]) assert.deepEqual(await service.send(request), {outcome: 'rejected', reason}, JSON.stringify(request));
  assert.deepEqual(sendRequests(fake), [], 'no Core request for an unlisted target');
  assert.equal((await service.send({sourceKey: src.sourceKey, address: 't1', text: 'hi'})).outcome, 'submitted');
  assert.deepEqual(fake.state.typed.map(item => item.terminal), ['t1']);
});

test('listed blocked, done, error and unknown agents are refused without contacting Core', async t => {
  const {fake, src} = await connectedSource(t, [
    agentTerminal('t1', 'blocked'), agentTerminal('t2', 'done'), agentTerminal('t3', 'error'), agentTerminal('t4', null),
    agentTerminal('t5', 'idle', {status: {state: 'idle', app: 'mystery-app'}}),
  ]);
  assert.deepEqual(await src.sendMessage('t1', 'yes'), {outcome: 'rejected', reason: 'blocked'});
  assert.deepEqual(await src.sendMessage('t2', 'hi'), {outcome: 'rejected', reason: 'not_sendable_status'});
  assert.deepEqual(await src.sendMessage('t3', 'hi'), {outcome: 'rejected', reason: 'not_sendable_status'});
  assert.deepEqual(await src.sendMessage('t4', 'hi'), {outcome: 'rejected', reason: 'not_sendable_status'});
  assert.deepEqual(await src.sendMessage('t5', 'hi'), {outcome: 'rejected', reason: 'unknown_app'});
  assert.deepEqual(sendRequests(fake), []);
  assert.deepEqual(fake.state.typed, []);
});

test('the fresh terminal.get re-check refuses changed labels, state, status, dialogs and identity before any send', async t => {
  const cases = [
    ['label_mismatch', {labels: {repo: 'acme-corp-internal'}}],
    ['not_live', {state: 'finished', foreground: null}],
    ['status_unknown', {status: null, reported: false}],
    ['blocked', {status: {state: 'blocked', app: 'claude', msg: 'secret status message'}}],
    ['blocked', {status: {state: 'idle', app: 'claude', kind: 'permission'}}],
    ['not_sendable_status', {status: {state: 'done', app: 'claude'}}],
    ['not_sendable_status', {status: {state: 'error', app: 'claude'}}],
    ['not_sendable_status', {status: {state: 'thinking', app: 'claude'}}],
    ['unknown_app', {status: {state: 'idle', app: 'mystery-app'}}],
    ['unknown_identity', {foreground: null}],
    ['unknown_identity', {foreground: {pid: 3, name: 'node', argv: ['node', 'busy.js'], cwd: '/Users/someone/secret-project'}}],
    ['unknown_identity', {foreground: {pid: 3, name: '2.1.3', argv: ['2.1.3'], cwd: '/Users/someone/secret-project'}}],
    ['ambiguous_identity', {foreground: {pid: 3, name: 'node', argv: ['claude', '--secret-flag'], cwd: '/Users/someone/secret-project'}}],
    ['identity_mismatch', {foreground: agentForeground('codex')}],
    ['target_changed', {status: {state: 'idle', app: 'codex'}, foreground: agentForeground('codex')}],
  ];
  for (const [reason, change] of cases) {
    const {fake, src} = await connectedSource(t, [agentTerminal('t1', 'idle')]);
    changeInCore(fake, 't1', change);
    const result = await src.sendMessage('t1', 'hi');
    assert.deepEqual(result, {outcome: 'rejected', reason}, JSON.stringify(change));
    assert.deepEqual(sendRequests(fake).map(item => item.method), ['hello', 'terminal.get'], reason);
    assert.deepEqual(fake.state.typed, []);
  }
  // A terminal removed from Core between listing and sending.
  const {fake, src} = await connectedSource(t, [agentTerminal('t1', 'idle')]);
  fake.state.terminals = [];
  assert.deepEqual(await src.sendMessage('t1', 'hi'), {outcome: 'rejected', reason: 'target_changed'});
  assert.equal(sendCalls(fake).length, 0);
});

test('an offline or stale source refuses to send', async t => {
  let clock = Date.now();
  const {fake, src} = await connectedSource(t, [agentTerminal('t1', 'idle')], {now: () => clock});
  clock += 120_000;
  assert.deepEqual(await src.sendMessage('t1', 'hi'), {outcome: 'rejected', reason: 'source_offline'});
  clock = Date.now();
  src.goOffline('test');
  assert.deepEqual(await src.sendMessage('t1', 'hi'), {outcome: 'rejected', reason: 'source_offline'});
  assert.deepEqual(coreWrites(fake), []);
});

test('Core refusals at send time are reported, never retried, and never forced', async t => {
  // Status turns blocked between terminal.get and terminal.send: Core refuses because force is never set.
  let {fake, src} = await connectedSource(t, [agentTerminal('t1', 'idle')]);
  fake.state.beforeSend = state => { state.terminals = state.terminals.map(item => ({...item, status: {state: 'blocked', app: 'claude', kind: 'permission'}})); };
  assert.deepEqual(await src.sendMessage('t1', 'y'), {outcome: 'refused', reason: 'blocked'});
  assert.equal(sendCalls(fake).length, 1);
  assert.deepEqual(fake.state.typed, []);
  // Status changes idle -> working in between: the if precondition makes Core refuse.
  ({fake, src} = await connectedSource(t, [agentTerminal('t1', 'idle')]));
  fake.state.beforeSend = state => { state.terminals = state.terminals.map(item => ({...item, status: {state: 'working', app: 'claude'}})); };
  assert.deepEqual(await src.sendMessage('t1', 'hi'), {outcome: 'refused', reason: 'status_mismatch'});
  assert.equal(sendCalls(fake).length, 1);
  assert.deepEqual(fake.state.typed, []);
  for (const kind of ['unavailable', 'finished', 'not_found']) {
    ({fake, src} = await connectedSource(t, [agentTerminal('t1', 'idle')]));
    fake.state.sendBehavior = kind;
    assert.deepEqual(await src.sendMessage('t1', 'hi'), {outcome: 'refused', reason: kind});
    assert.equal(sendCalls(fake).length, 1, kind);
  }
});

test('a lost, timed-out or unrecognized send result is uncertain and is not retried', async t => {
  for (const [behavior, reason] of [['hang', 'timeout'], ['close', 'connection_lost'], ['cancelled', 'core_uncertain']]) {
    const {fake, src} = await connectedSource(t, [agentTerminal('t1', 'idle')], {sendTimeoutMs: 150});
    fake.state.sendBehavior = behavior;
    assert.deepEqual(await src.sendMessage('t1', 'hi'), {outcome: 'uncertain', reason}, behavior);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(sendCalls(fake).length, 1, `${behavior}: exactly one terminal.send`);
    assert.equal(src.sending.size, 0);
  }
});

test('a second message to the same agent is refused while one is in flight', async t => {
  const {fake, src} = await connectedSource(t, [agentTerminal('t1', 'idle')], {sendTimeoutMs: 300});
  fake.state.sendBehavior = 'hang';
  const first = src.sendMessage('t1', 'first');
  await until(() => sendCalls(fake).length === 1, {label: 'first send'});
  assert.deepEqual(await src.sendMessage('t1', 'second'), {outcome: 'rejected', reason: 'send_in_progress'});
  assert.equal((await first).outcome, 'uncertain');
  assert.equal(sendCalls(fake).length, 1);
});

test('the send connection refuses other methods, force, missing or blocked preconditions and odd parameters before writing', () => {
  const written = [];
  const fakeSocket = new net.Socket();
  fakeSocket.write = line => { written.push(line); return true; };
  const conn = openCoreConnection(() => fakeSocket, '/unused', {methods: SEND_METHODS});
  for (const method of ['events.subscribe', 'terminal.list', 'terminal.read', 'terminal.attach', 'terminal.keys', 'terminal.interrupt', 'terminal.kill', 'terminal.run', 'terminal.put', 'machine.exec', 'shell', 'file.read', 'file.write', 'doc.get', 'doc.set']) {
    assert.throws(() => conn.request(method, {terminal: 't1'}), /not allowed/, method);
  }
  for (const params of [
    {terminal: 't1', text: 'hi', if: 'idle', force: true},
    {terminal: 't1', text: 'hi', if: 'idle', force: false},
    {terminal: 't1', text: 'hi'},
    {terminal: 't1', text: 'hi', if: 'blocked'},
    {terminal: 't1', text: 'hi', if: 'idle', wait: true},
    {terminal: 'machine/t1', text: 'hi', if: 'idle'},
    {terminal: 'secret-project-name', text: 'hi', if: 'idle'},
    {terminal: 't1', text: '\u001b[201~rm -rf ~\r', if: 'idle'},
    {terminal: 't1', text: '', if: 'idle'},
  ]) assert.throws(() => conn.request('terminal.send', params), /not allowed/, JSON.stringify(params));
  for (const params of [{terminal: 'secret-project-name'}, {terminal: 't1', caller: 't2'}, {}]) {
    assert.throws(() => conn.request('terminal.get', params), /not allowed/, JSON.stringify(params));
  }
  const status = openCoreConnection(() => fakeSocket, '/unused', {});
  for (const method of ['terminal.get', 'terminal.send']) assert.throws(() => status.request(method, {terminal: 't1', text: 'hi', if: 'idle'}), /not allowed/);
  assert.deepEqual(written, []);
  conn.close(); status.close();
});

test('message text must be plain, bounded and non-empty', () => {
  assert.equal(validMessageText('hello\n\tworld'), true);
  assert.equal(validMessageText('x'.repeat(4000)), true);
  for (const text of ['', '   \n', 'x'.repeat(4001), 'a\u001b[2J', 'a\rb', 'a\u0003', 'a\u0000', 'a\u009b', 'a ', 42, null]) assert.equal(validMessageText(text), false, JSON.stringify(text));
});

test('the send-time projection keeps only derived values and a generic runtime kind', () => {
  const projected = projectSendTarget(agentTerminal('t1', 'idle'));
  assert.deepEqual(Object.keys(projected).sort(), SEND_KEYS);
  assert.deepEqual(projected, {address: 't1', labelsMatch: true, live: true, reported: true, statusState: 'idle', progress: null, app: 'claude', dialog: false, runtime: 'claude'});
  assertNoSecrets(projected, 'projection');
  assert.equal(projectSendTarget(companyTerminal()).labelsMatch, false);
  assert.equal(foregroundRuntime({name: 'codex', argv: ['/opt/homebrew/bin/codex']}), 'codex');
  assert.equal(foregroundRuntime({name: 'python3', argv: ['python3']}), '');
  assert.equal(foregroundRuntime({name: 'node', argv: ['claude']}), 'ambiguous');
  assert.equal(sendTargetRefusal(projected, {address: 't1', kind: 'claude'}), '');
  assert.equal(sendTargetRefusal(projected, {address: 't2', kind: 'claude'}), 'target_changed');
  assert.equal(sendTargetRefusal(null, {address: 't1', kind: 'claude'}), 'target_changed');
});

function fakeRes() {
  return {statusCode: 0, headers: {}, body: '', setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = value; }};
}
function messageReq(body, {headers = {}, method = 'POST', remoteAddress = '127.0.0.1', url = AGENT_MESSAGE_PATH} = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const req = Readable.from(text ? [Buffer.from(text)] : []);
  return Object.assign(req, {method, url, socket: {remoteAddress}, headers: {host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers}});
}
async function call(handle, req) {
  const res = fakeRes();
  await handle(req, res, () => assert.fail('message route should handle'));
  return {status: res.statusCode, headers: res.headers, body: JSON.parse(res.body)};
}

test('message route: same-origin JSON POST reaches only the selected listed agent and returns no Core metadata', async t => {
  const {fake, src} = await connectedSource(t, [agentTerminal('t1', 'idle'), companyTerminal('t99')]);
  const service = createAgentStatusService({sources: [src], idleStopMs: 60_000});
  t.after(() => service.stop());
  const handle = createAgentStatusHandler({env: {}, service});
  const ok = await call(handle, messageReq({sourceKey: src.sourceKey, address: 't1', text: 'hi'}));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['Cache-Control'], 'no-store');
  assert.deepEqual(ok.body, {delivered: true, outcome: 'submitted', status: 'idle', started: true});
  const missing = await call(handle, messageReq({sourceKey: src.sourceKey, address: 't99', text: 'hi'}));
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, {delivered: false, outcome: 'rejected', reason: 'unknown_target'});
  assertNoSecrets([ok.body, missing.body], 'http');
  assert.deepEqual(fake.state.typed.map(item => item.terminal), ['t1']);
});

test('message route enforces POST, loopback, same origin, JSON, size and shape limits, and the disabled modes', async () => {
  const sent = [];
  const service = {send: async message => { sent.push(message); return {outcome: 'submitted', status: 'idle', started: null}; }, poll: () => ({sources: []})};
  const handle = createAgentStatusHandler({env: {}, service});
  const good = {sourceKey: 'c0123456789', address: 't1', text: 'hi'};
  const cases = [
    [messageReq(good, {method: 'GET'}), 405],
    [messageReq(good, {method: 'PUT'}), 405],
    [messageReq(good, {remoteAddress: '192.168.1.5'}), 403],
    [messageReq(good, {headers: {host: 'evil.example'}}), 403],
    [messageReq(good, {headers: {origin: 'http://evil.example'}}), 403],
    [messageReq(good, {headers: {origin: undefined}}), 403],
    [messageReq(good, {headers: {'sec-fetch-site': 'cross-site'}}), 403],
    [messageReq(good, {headers: {'content-type': 'text/plain'}}), 415],
    [messageReq(good, {headers: {'content-type': 'application/x-www-form-urlencoded'}}), 415],
    [messageReq(good, {headers: {'content-length': '999999'}}), 413],
    [messageReq({...good, text: 'x'.repeat(20_000)}), 413],
    [messageReq('{not json'), 400],
    [messageReq([good]), 400],
    [messageReq({...good, method: 'terminal.kill'}), 400],
    [messageReq({...good, force: true}), 400],
    [messageReq({...good, terminal: 't2'}), 400],
    [messageReq({...good, address: 'machine/t1'}), 400],
    [messageReq({...good, sourceKey: '/Users/someone/default.sock'}), 400],
    [messageReq({...good, text: '\u001b[201~'}), 400],
    [messageReq({...good, text: '  '}), 400],
    [messageReq({...good, text: 'x'.repeat(4001)}), 400],
  ];
  for (const [req, status] of cases) {
    const res = await call(handle, req);
    assert.equal(res.status, status, `${req.method} ${JSON.stringify(req.headers)}`);
    assert.equal(res.body.delivered, false);
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
  assert.deepEqual(sent, []);
  assert.equal((await call(handle, messageReq(good))).status, 200);
  assert.deepEqual(sent, [good]);
  for (const env of [{VITE_PUBLIC_DEMO: 'true'}, {AI_OFFICE_HERDR_CORE_STATUS: 'off'}]) {
    const res = await call(createAgentStatusHandler({env, service}), messageReq(good));
    assert.equal(res.status, 404);
  }
  assert.equal(sent.length, 1);
  assert.deepEqual(parseMessageBody(JSON.stringify(good)), good);
});

test('message route maps outcomes to distinct HTTP statuses', async () => {
  for (const [result, status] of [
    [{outcome: 'rejected', reason: 'blocked'}, 409], [{outcome: 'refused', reason: 'status_mismatch'}, 409],
    [{outcome: 'uncertain', reason: 'timeout'}, 504], [{outcome: 'rejected', reason: 'unknown_target'}, 404],
  ]) {
    const handle = createAgentStatusHandler({env: {}, service: {send: async () => result}});
    const res = await call(handle, messageReq({sourceKey: 'c0123456789', address: 't1', text: 'hi'}));
    assert.equal(res.status, status);
    assert.deepEqual(res.body, {delivered: false, ...result});
  }
  const throwing = createAgentStatusHandler({env: {}, service: {send: async () => { throw new Error('boom'); }}});
  const res = await call(throwing, messageReq({sourceKey: 'c0123456789', address: 't1', text: 'hi'}));
  assert.deepEqual([res.status, res.body.outcome], [504, 'uncertain']);
});

test('the composer is enabled only for listed idle or working agents with a recognized kind', () => {
  const terminalOf = (kind = 'claude') => ({address: 't1', kind});
  assert.equal(coreComposerBlock({state: 'idle'}, terminalOf()), '');
  assert.equal(coreComposerBlock({state: 'working'}, terminalOf()), '');
  for (const state of ['blocked', 'done', 'error', 'unknown', 'offline']) assert.notEqual(coreComposerBlock({state}, terminalOf()), '', state);
  assert.match(coreComposerBlock({state: 'blocked'}, terminalOf()), /不會代為回答/);
  assert.notEqual(coreComposerBlock({state: 'idle'}, terminalOf('')), '');
  assert.notEqual(coreComposerBlock({state: 'idle'}, null), '');
});

test('delivery wording never implies an agent reply and asks the user to check before resending', () => {
  const submitted = coreDeliveryText({delivery: 'submitted', started: true});
  assert.equal(submitted.label, '已提交給 Herdr Core');
  assert.match(submitted.detail, /不會顯示 Agent 回覆/);
  for (const entry of [{delivery: 'rejected', reason: 'blocked'}, {delivery: 'refused', reason: 'status_mismatch'}, {delivery: 'uncertain', reason: 'timeout'}, {delivery: 'uncertain', reason: 'network'}]) {
    const text = coreDeliveryText(entry);
    assert.match(text.detail, /確認目標終端/, entry.delivery);
    assert.match(text.detail, /不會自動重試/, entry.delivery);
    assert.doesNotMatch(text.label + text.detail, /已回覆|回覆了/);
  }
  assert.equal(coreDeliveryText({delivery: 'uncertain'}).label, '結果不明');
});

test('fake Core never receives an unfiltered request and the company terminal is never typed into', async t => {
  const {fake, src} = await connectedSource(t, [agentTerminal('t1', 'idle'), companyTerminal('t99'), terminal('t2', 'idle')]);
  await src.sendMessage('t1', 'hi');
  await src.sendMessage('t99', 'hi');
  await src.sendMessage('t2', 'hi');
  assert.deepEqual(fake.state.subscribeParams, [{labels: {repo: 'ai-office-islands'}}]);
  assert.deepEqual(fake.state.requests.filter(item => item.method === 'terminal.get').map(item => item.params.terminal), ['t1', 't2']);
  assert.deepEqual(fake.state.typed.map(item => item.terminal), ['t1']);
});
