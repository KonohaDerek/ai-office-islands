import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALLOWED_COMMANDS, COMMAND_MAX_BYTES, COMMAND_TIMEOUT_MS, STALE_AFTER_MS,
  classifyExecError, createOverviewHandler, createSnapshotStore, normalizeSnapshot,
  overviewDisabled, rejectRequest, runAllowlistedCommand, sanitizeLabel,
} from '../server/project-overview.mjs';
import {freshness, overviewErrorKind, summarizeProjects} from '../src/project-overview-utils.mjs';

const observedAt = '2026-11-10T08:00:00.000Z';
const term = (terminal, app, status, extra = {}) => ({terminal, pane: 'p1', status, app, name: {}, sub_agents: [], ...extra});
const herdr = spaces => ({ok: true, stdout: JSON.stringify({spaces, recent: [{name: 'x', folder: '/Users/someone/secret'}]})});
const hc = terminals => ({ok: true, stdout: JSON.stringify({hidden_finished: 0, terminals})});

function sample() {
  return normalizeSnapshot({
    herdr: herdr([
      {id: 'spAlpha', name: 'Alpha', folder: '/Users/someone/alpha', tabs: [{id: 'tb1', name: 'fix login prompt', terminals: [term('t1', 'codex', 'working'), term('t2', null, null)]}]},
      {id: 'spBeta', name: 'Beta', folder: '/Users/someone/beta', tabs: [{id: 'tb2', name: 'tab', terminals: [term('t3', 'claude-code', 'blocked'), term('t4', 'hermes', 'done', {sub_agents: ['t9', 't10']})]}]},
      {id: 'spGamma', name: 'Gamma', folder: '/x', tabs: [{id: 'tb3', name: 'tab', terminals: [term('t5', 'codex', 'done')]}]},
      {id: 'spDelta', name: 'Delta', folder: '/x', tabs: [{id: 'tb4', name: 'tab', terminals: [term('t6', 'codex', null)]}]},
      {id: 'spEmpty', name: 'Empty', folder: '/x', tabs: []},
    ]),
    hc: hc([
      {address: 't1', agent: 'codex', cwd: '/Users/someone/alpha', state: 'live', status: 'working', name: 'secret task text', where: 'Alpha / tab'},
      {address: 't6', agent: 'codex', cwd: '/x', state: 'live', status: 'idle', where: 'Delta / tab'},
      {address: 't7', agent: 'zsh', cwd: '/x', state: 'finished', exit_code: 1, reason: 'killed', where: 'Alpha / tab'},
      {address: 't8', agent: 'zsh', cwd: '/x', state: 'finished', where: 'Nowhere / tab'},
    ]),
  }, observedAt);
}

test('normalizes Herdr spaces into project status counts', () => {
  const snapshot = sample();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.observedAt, observedAt);
  assert.equal(snapshot.timeBasis, 'observed');
  assert.equal(snapshot.updatedAt, null);
  assert.equal(snapshot.staleAfterMs, STALE_AFTER_MS);
  const alpha = snapshot.projects.find(p => p.id === 'spAlpha');
  assert.deepEqual(alpha.counts, {blocked: 0, review: 0, waiting: 0, unknown: 0, working: 1});
  assert.equal(alpha.agents, 1);
  assert.equal(alpha.shells, 1);
  assert.equal(alpha.ended, 1);
  assert.equal(snapshot.unattributedEnded, 1);
  const beta = snapshot.projects.find(p => p.id === 'spBeta');
  assert.equal(beta.subAgents, 2);
  assert.deepEqual(beta.agentsByKind, {'claude-code': 1, hermes: 1});
});

test('sorts blocked first, then turn-ended/waiting, and never reports done as complete', () => {
  const snapshot = sample();
  assert.deepEqual(snapshot.projects.map(p => [p.name, p.status]), [
    ['Beta', 'blocked'], ['Gamma', 'review'], ['Delta', 'waiting'], ['Alpha', 'working'], ['Empty', 'none'],
  ]);
  assert.ok(!JSON.stringify(snapshot).match(/"(done|complete|completed)"/));
});

test('falls back to hc status and marks unrecognised status as unknown', () => {
  const snapshot = normalizeSnapshot({
    herdr: herdr([{id: 'sp1', name: 'One', tabs: [{terminals: [term('t1', 'codex', 'sleeping'), term('t2', 'codex', undefined)]}]}]),
    hc: {ok: false, error: 'timeout'},
  }, observedAt);
  assert.equal(snapshot.projects[0].status, 'unknown');
  assert.equal(snapshot.projects[0].counts.unknown, 2);
  assert.equal(snapshot.sources.hc.state, 'error');
  assert.equal(snapshot.sources.hc.error, 'timeout');
  assert.equal(snapshot.available, true);
});

test('recognizes hc agent "claude" as Claude Code when Herdr has no app', () => {
  const snapshot = normalizeSnapshot({
    herdr: herdr([{id: 'sp1', name: 'One', tabs: [{terminals: [term('t1', null, null)]}]}]),
    hc: hc([{address: 't1', agent: 'claude', state: 'live', status: 'working'}]),
  }, observedAt);
  const [project] = snapshot.projects;
  assert.equal(project.agents, 1);
  assert.equal(project.shells, 0);
  assert.equal(project.status, 'working');
  assert.deepEqual(project.agentsByKind, {'claude-code': 1});
});

test('unrecognised agent names stay non-agent terminals', () => {
  const snapshot = normalizeSnapshot({
    herdr: herdr([{id: 'sp1', name: 'One', tabs: [{terminals: [term('t1', null, null), term('t2', null, null), term('t3', 'Claude', 'working')]}]}]),
    hc: hc([
      {address: 't1', agent: 'claude-desktop', state: 'live', status: 'working'},
      {address: 't2', agent: 'zsh', state: 'live'},
    ]),
  }, observedAt);
  const [project] = snapshot.projects;
  assert.equal(project.agents, 0);
  assert.equal(project.shells, 3);
  assert.equal(project.status, 'none');
  assert.deepEqual(project.agentsByKind, {});
});

test('source failures make the project list unknown, not empty-and-idle', () => {
  for (const herdrResult of [{ok: false, error: 'not_found'}, {ok: true, stdout: 'not json'}, {ok: true, stdout: '{"spaces":"x"}'}, undefined]) {
    const snapshot = normalizeSnapshot({herdr: herdrResult, hc: hc([])}, observedAt);
    assert.equal(snapshot.available, false);
    assert.deepEqual(snapshot.projects, []);
    assert.notEqual(snapshot.sources.herdr.state, 'ok');
  }
  assert.equal(normalizeSnapshot({herdr: {ok: true, stdout: 'garbage'}}, observedAt).sources.herdr.error, 'invalid_output');
});

test('excludes paths, terminal text, labels, cwd, exit codes and secrets', () => {
  const snapshot = normalizeSnapshot({
    herdr: herdr([
      {id: 'sp1', name: '/Users/someone/project', folder: '/Users/someone/project', tabs: [{name: 'deploy with sk-abcdefghijklmnop', terminals: [term('t1', 'codex', 'idle')]}]},
      {id: 'sp2', name: 'token sk-proj-abcdefghijk123', tabs: []},
      {id: 'sp3', name: 'ghp_abcdefghijklmnopqrstuvwxyz', tabs: []},
      {id: '../../etc/passwd', name: '<img src=x onerror=alert(1)>‮evil\u0007', tabs: []},
      {id: 'sp5', name: '~/notes', tabs: []},
    ]),
    hc: hc([{address: 't1', agent: 'codex', cwd: '/Users/someone/project', name: 'prompt text', state: 'live', status: 'idle', exit_code: 3}]),
  }, observedAt);
  const text = JSON.stringify(snapshot);
  for (const forbidden of ['/Users', 'someone', 'sk-', 'ghp_', 'prompt text', 'deploy', 'cwd', 'folder', 'exit_code', '<img', '‮', '\u0007', 'passwd', '~/']) {
    assert.ok(!text.includes(forbidden), `snapshot leaked ${JSON.stringify(forbidden)}`);
  }
  assert.match(snapshot.projects.find(p => p.name.includes('img')).id, /^p_[0-9a-f]{16}$/);
});

test('sanitizeLabel keeps normal names and trims length', () => {
  assert.equal(sanitizeLabel('  測試   專案 '), '測試 專案');
  assert.equal(sanitizeLabel(42), '未命名專案');
  assert.equal([...sanitizeLabel('長'.repeat(200))].length, 60);
});

test('freshness reports stale and unknown observation times', () => {
  const now = Date.parse(observedAt);
  assert.equal(freshness(observedAt, now + 59_000, 60_000), 'fresh');
  assert.equal(freshness(observedAt, now + 61_000, 60_000), 'stale');
  assert.equal(freshness(null, now, 60_000), 'unknown');
  assert.equal(freshness('not a date', now, 60_000), 'unknown');
  assert.deepEqual(summarizeProjects([{status: 'blocked'}, {status: 'bogus'}, {}]), {blocked: 1, review: 0, waiting: 0, unknown: 2, working: 0, none: 0});
});

test('client error mapping distinguishes offline, unavailable and forbidden', () => {
  assert.equal(overviewErrorKind({online: false, status: 500}), 'offline');
  assert.equal(overviewErrorKind({status: 404}), 'unavailable');
  assert.equal(overviewErrorKind({status: 403}), 'forbidden');
  assert.equal(overviewErrorKind({}), 'offline-service');
  assert.equal(overviewErrorKind({status: 500}), 'error');
});

const req = (overrides = {}) => ({method: 'GET', url: '/api/project-overview', socket: {remoteAddress: '127.0.0.1'}, headers: {host: '127.0.0.1:4173'}, ...overrides});

test('rejects non-GET, non-loopback, foreign Host/Origin and cross-site requests', () => {
  assert.equal(rejectRequest(req()), null);
  assert.equal(rejectRequest(req({socket: {remoteAddress: '::1'}, headers: {host: 'localhost:4173', origin: 'http://localhost:4173', 'sec-fetch-site': 'same-origin'}})), null);
  assert.equal(rejectRequest(req({socket: {remoteAddress: '::ffff:127.0.0.1'}})), null);
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) assert.equal(rejectRequest(req({method})).status, 405);
  for (const remoteAddress of ['192.168.1.20', '10.0.0.2', '::ffff:192.168.1.20', undefined]) assert.equal(rejectRequest(req({socket: {remoteAddress}})).error, 'loopback_only');
  for (const host of ['evil.example', 'terminal.local:4173', '127.0.0.1.evil.example', '', undefined]) assert.equal(rejectRequest(req({headers: {host}})).error, 'host_not_allowed');
  for (const origin of ['http://evil.example', 'https://127.0.0.1:4173', 'http://127.0.0.1:9999', 'null', 'http://localhost:4173']) {
    assert.equal(rejectRequest(req({headers: {host: '127.0.0.1:4173', origin}})).error, 'origin_not_allowed');
  }
  assert.equal(rejectRequest(req({headers: {host: '127.0.0.1:4173', 'sec-fetch-site': 'cross-site'}})).error, 'cross_site');
});

function response() {
  return {statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; }};
}

test('handler is disabled for the public demo and serves only its own path', async () => {
  assert.equal(overviewDisabled({VITE_PUBLIC_DEMO: 'true'}), true);
  assert.equal(overviewDisabled({AI_OFFICE_PROJECT_OVERVIEW: 'off'}), true);
  assert.equal(overviewDisabled({}), false);
  let ran = false;
  const disabled = createOverviewHandler({env: {VITE_PUBLIC_DEMO: 'true'}, getSnapshot: async () => { ran = true; }});
  const res = response();
  await disabled(req(), res, () => assert.fail('should not call next'));
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).error, 'disabled');
  assert.equal(ran, false);
  let nextCalled = false;
  await disabled(req({url: '/other'}), response(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('handler rejects bad requests without running commands and serves the snapshot otherwise', async () => {
  let runs = 0;
  const handler = createOverviewHandler({env: {}, getSnapshot: async () => { runs += 1; return {available: true, projects: []}; }});
  const post = response();
  await handler(req({method: 'POST'}), post, () => {});
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers.allow, 'GET');
  const foreign = response();
  await handler(req({headers: {host: '127.0.0.1:4173', origin: 'http://evil.example'}}), foreign, () => {});
  assert.equal(foreign.statusCode, 403);
  assert.equal(runs, 0);
  const ok = response();
  await handler(req(), ok, () => {});
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.equal(runs, 1);
});

test('snapshot store shares one in-flight run and caches between clients', async () => {
  let clock = 1_000_000, calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const run = async key => { calls.push(key); await gate; return key === 'herdr' ? herdr([]) : hc([]); };
  const get = createSnapshotStore({run, now: () => clock});
  const a = get(), b = get({refresh: true});
  release();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first, second);
  assert.deepEqual(calls.sort(), ['hc', 'herdr']);
  clock += 1_000;
  assert.equal(await get({refresh: true}), first, 'refresh within the minimum interval reuses the snapshot');
  clock += 1_500;
  assert.notEqual(await get({refresh: true}), first);
  assert.equal(calls.length, 4);
});

test('runs only fixed allowlisted argv through execFile without a shell', async () => {
  const seen = [];
  const exec = (file, args, options, callback) => { seen.push({file, args, options}); callback(null, '{"spaces":[]}'); };
  assert.deepEqual(await runAllowlistedCommand('herdr', exec), {ok: true, stdout: '{"spaces":[]}'});
  await runAllowlistedCommand('hc', exec);
  assert.deepEqual(await runAllowlistedCommand('rm -rf /', exec), {ok: false, error: 'not_allowed'});
  assert.deepEqual(seen.map(s => [s.file, ...s.args]), [['herdr-app', 'ls'], ['hc', 'ls', '--all', '--json']]);
  for (const {options} of seen) {
    assert.equal(options.shell, false);
    assert.equal(options.timeout, COMMAND_TIMEOUT_MS);
    assert.equal(options.maxBuffer, COMMAND_MAX_BYTES);
    assert.deepEqual(Object.keys(options.env).sort(), ['HOME', 'LANG', 'PATH']);
  }
  assert.ok(Object.isFrozen(ALLOWED_COMMANDS) && Object.isFrozen(ALLOWED_COMMANDS.hc.args));
  const failing = (file, args, options, callback) => callback(Object.assign(new Error('x'), {killed: true, signal: 'SIGKILL'}));
  assert.deepEqual(await runAllowlistedCommand('hc', failing), {ok: false, error: 'timeout'});
  assert.equal(classifyExecError({code: 'ENOENT'}), 'not_found');
  assert.equal(classifyExecError({code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'}), 'output_too_large');
});
