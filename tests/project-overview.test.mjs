import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALLOWED_COMMANDS, COMMAND_MAX_BYTES, COMMAND_TIMEOUT_MS, MAX_PROJECTS, MAX_SUB_AGENTS_PER_TERMINAL, MAX_TERMINALS, STALE_AFTER_MS,
  classifyExecError, createOverviewHandler, createSnapshotStore, normalizeSnapshot,
  overviewDisabled, rejectRequest, runAllowlistedCommand, sanitizeLabel,
} from '../server/project-overview.mjs';
import {agentSummaryLabel, countLabel, endedLabel, focusTrapTarget, formatObservedTime, freshness, omittedProjects, overviewErrorKind, subAgentsLabel, summarizeProjects, truncationNotes, unattributedEndedNote} from '../src/project-overview-utils.mjs';

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
      {address: 't2', agent: 'zsh', cwd: '/x', state: 'live', where: 'Alpha / tab'},
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

const shellOnlyHerdr = () => herdr([{id: 'sp1', name: 'One', tabs: [{terminals: [term('t1', null, null)]}]}]);

test('hc failure keeps app-less terminals unknown, not shells or "no agents"', () => {
  for (const hcResult of [{ok: false, error: 'timeout'}, {ok: false, error: 'not_found'}, {ok: true, stdout: 'not json'}, {ok: true, stdout: '{"terminals":"x"}'}, undefined]) {
    const snapshot = normalizeSnapshot({herdr: shellOnlyHerdr(), hc: hcResult}, observedAt);
    const [project] = snapshot.projects;
    assert.notEqual(snapshot.sources.hc.state, 'ok');
    assert.equal(project.status, 'unknown');
    assert.equal(project.agents, 0);
    assert.equal(project.unidentified, 1);
    assert.equal(project.shells, 0);
    assert.equal(project.counts.unknown, 1);
    assert.equal(project.ended, null);
    assert.equal(snapshot.unattributedEnded, null);
  }
});

test('hc failure still trusts Herdr app identity and keeps other states visible', () => {
  const snapshot = normalizeSnapshot({
    herdr: herdr([{id: 'sp1', name: 'One', tabs: [{terminals: [term('t1', 'codex', 'blocked'), term('t2', null, null)]}]}]),
    hc: {ok: false, error: 'timeout'},
  }, observedAt);
  const [project] = snapshot.projects;
  assert.equal(project.status, 'blocked');
  assert.equal(project.agents, 1);
  assert.equal(project.unidentified, 1);
  assert.deepEqual(project.counts, {blocked: 1, review: 0, waiting: 0, unknown: 1, working: 0});
});

test('a terminal missing from a healthy hc listing is unknown; a known shell is a shell', () => {
  const snapshot = normalizeSnapshot({
    herdr: herdr([{id: 'sp1', name: 'One', tabs: [{terminals: [term('t1', null, null), term('t2', null, null)]}]}]),
    hc: hc([{address: 't2', agent: 'zsh', state: 'live'}]),
  }, observedAt);
  const [project] = snapshot.projects;
  assert.equal(project.unidentified, 1);
  assert.equal(project.shells, 1);
  assert.equal(project.status, 'unknown');
  assert.equal(project.ended, 0);
  assert.equal(snapshot.unattributedEnded, 0);
});

test('duplicate and non-string space IDs produce unique, stable output IDs', () => {
  const spaces = [
    {id: 'spSame', name: 'First', tabs: []},
    {id: 'spSame', name: 'Second', tabs: []},
    {id: 'spSame~2', name: 'Third', tabs: []},
    {id: 42, name: 'Number', tabs: []},
    {id: '42', name: 'String 42', tabs: []},
    {name: 'No id A', tabs: []},
    {name: 'No id B', tabs: []},
    {id: {nested: true}, name: 'Object', tabs: []},
    null,
  ];
  const first = normalizeSnapshot({herdr: herdr(spaces), hc: hc([])}, observedAt);
  const ids = first.projects.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 8);
  const byName = Object.fromEntries(first.projects.map(p => [p.name, p.id]));
  assert.equal(byName.First, 'spSame');
  assert.notEqual(byName.Second, byName.First);
  assert.notEqual(byName.Third, byName.Second);
  assert.notEqual(byName.Number, byName['String 42']);
  assert.notEqual(byName['No id A'], byName['No id B']);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_~-]{1,80}$/);
  const again = normalizeSnapshot({herdr: herdr(spaces), hc: hc([])}, observedAt);
  assert.deepEqual(again.projects.map(p => [p.name, p.id]), first.projects.map(p => [p.name, p.id]));
});

test('ended counts attribute to the right project after invalid spaces are skipped', () => {
  const snapshot = normalizeSnapshot({
    herdr: herdr([null, {id: 'spA', name: 'A', tabs: []}, {id: 'spB', name: 'B', tabs: []}]),
    hc: hc([{address: 't9', agent: 'zsh', state: 'finished', where: 'B / tab'}]),
  }, observedAt);
  const byName = Object.fromEntries(snapshot.projects.map(p => [p.name, p]));
  assert.equal(byName.A.ended, 0);
  assert.equal(byName.B.ended, 1);
});

test('UI labels render unknown values as unknown, never zero', () => {
  assert.equal(countLabel(null), '未知（hc 無法讀取）');
  assert.equal(countLabel(undefined), '未知（hc 無法讀取）');
  assert.equal(countLabel(0), '0');
  assert.equal(agentSummaryLabel({agents: 0, unidentified: 2}), '代理身分未知');
  assert.equal(agentSummaryLabel({agents: 0, unidentified: 0}), '沒有代理終端');
  assert.equal(agentSummaryLabel({agents: 2, unidentified: 1}), '2 個代理 · 1 個身分未知');
  assert.match(unattributedEndedNote({available: true, unattributedEnded: null}), /未知/);
  assert.match(unattributedEndedNote({available: true, unattributedEnded: 3}), /3 個已結束終端/);
  assert.equal(unattributedEndedNote({available: true, unattributedEnded: 0}), '');
  assert.equal(unattributedEndedNote({available: false, unattributedEnded: null}), '');
});

test('observed time includes the date', () => {
  const label = formatObservedTime(observedAt);
  assert.match(label, /2026/);
  assert.match(label, /11/);
  assert.equal(formatObservedTime('nope'), '未知時間');
});

test('focus trap wraps Tab and Shift+Tab inside the dialog', () => {
  const panel = {name: 'panel'}, a = {name: 'a'}, b = {name: 'b'}, c = {name: 'c'};
  const items = [a, b, c];
  assert.equal(focusTrapTarget({items, active: c, inside: true, shiftKey: false, panel}), a);
  assert.equal(focusTrapTarget({items, active: a, inside: true, shiftKey: true, panel}), c);
  assert.equal(focusTrapTarget({items, active: panel, inside: true, shiftKey: true, panel}), c);
  assert.equal(focusTrapTarget({items, active: b, inside: true, shiftKey: false, panel}), null);
  assert.equal(focusTrapTarget({items, active: {}, inside: false, shiftKey: false, panel}), a);
  assert.equal(focusTrapTarget({items, active: {}, inside: false, shiftKey: true, panel}), c);
  assert.equal(focusTrapTarget({items: [], active: {}, inside: false, shiftKey: false, panel}), panel);
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

// Truncation boundaries: caps stay, but anything past them is reported, never silent.
const spacesOf = (count, lastStatus = 'working') => Array.from({length: count}, (_, i) => ({
  id: `sp${i}`, name: `P${i}`, tabs: [{terminals: [term(`t${i}`, 'codex', i === count - 1 ? lastStatus : 'working')]}],
}));
const finishedOf = count => Array.from({length: count}, (_, i) => ({address: `f${i}`, agent: 'zsh', state: 'finished', where: 'P0 / tab'}));

test('caps are the documented safety bounds', () => {
  assert.equal(MAX_PROJECTS, 100);
  assert.equal(MAX_TERMINALS, 500);
  assert.equal(MAX_SUB_AGENTS_PER_TERMINAL, 50);
});

test('exactly 100 projects is complete; 101 reports the omitted project as unknown', () => {
  const full = normalizeSnapshot({herdr: herdr(spacesOf(100, 'blocked')), hc: hc([])}, observedAt);
  assert.equal(full.projects.length, 100);
  assert.equal(full.partial, false);
  assert.equal(full.truncation.projects, null);
  assert.equal(full.projects[0].status, 'blocked');
  assert.deepEqual(truncationNotes(full), []);
  assert.equal(omittedProjects(full), 0);

  const over = normalizeSnapshot({herdr: herdr(spacesOf(101, 'blocked')), hc: hc([])}, observedAt);
  assert.equal(over.projects.length, 100);
  assert.ok(!over.projects.some(p => p.status === 'blocked'), 'the 101st (blocked) project is past the cap');
  assert.equal(over.partial, true);
  assert.deepEqual(over.truncation.projects, {limit: 100, total: 101, omitted: 1});
  assert.equal(omittedProjects(over), 1);
  const [note] = truncationNotes(over);
  assert.match(note, /101/);
  assert.match(note, /另有 1 個未納入，狀態未知/);
});

test('invalid spaces do not count toward the project cap or the omitted total', () => {
  const snapshot = normalizeSnapshot({herdr: herdr([null, 'x', [], [{id: 'arr'}], ...spacesOf(100)]), hc: hc([])}, observedAt);
  assert.equal(snapshot.projects.length, 100);
  assert.equal(snapshot.truncation.projects, null);
  assert.equal(snapshot.partial, false);
});

test('exactly 500 hc terminals is complete; 501 marks ended totals as a lower bound', () => {
  const full = normalizeSnapshot({herdr: herdr(spacesOf(1)), hc: hc(finishedOf(500))}, observedAt);
  assert.equal(full.projects[0].ended, 500);
  assert.equal(full.projects[0].endedPartial, false);
  assert.equal(full.truncation.terminals, null);
  assert.equal(full.partial, false);
  assert.equal(endedLabel(full.projects[0]), '500');

  const over = normalizeSnapshot({herdr: herdr(spacesOf(1)), hc: hc(finishedOf(501))}, observedAt);
  assert.equal(over.projects[0].ended, 500);
  assert.equal(over.projects[0].endedPartial, true);
  assert.equal(over.unattributedEndedPartial, true);
  assert.equal(over.partial, true);
  assert.deepEqual(over.truncation.terminals, {limit: 500, total: 501, omitted: 1});
  assert.match(endedLabel(over.projects[0]), /^至少 500（.*不完整）$/);
  assert.equal(unattributedEndedNote(over), 'hc 清單已截斷：可能還有未計入的已結束終端。');
  const unattributed = normalizeSnapshot({herdr: herdr(spacesOf(1)), hc: hc(finishedOf(501).map(t => ({...t, where: 'Nowhere / tab'})))}, observedAt);
  assert.match(unattributedEndedNote(unattributed), /^至少另有 500 個.*不完整/);
  assert.ok(truncationNotes(over).some(note => /501/.test(note) && /下限/.test(note)));
});

test('a live terminal past the hc cap without Herdr app/status is unknown, and the warning says so', () => {
  const spaces = [{id: 'sp1', name: 'One', tabs: [{terminals: [term('live', null, null)]}]}];
  const live = {address: 'live', agent: 'claude', state: 'live', status: 'blocked', where: 'One / tab'};
  const within = normalizeSnapshot({herdr: herdr(spaces), hc: hc([...finishedOf(499), live])}, observedAt);
  assert.equal(within.projects[0].status, 'blocked');
  assert.equal(within.projects[0].agents, 1);
  const past = normalizeSnapshot({herdr: herdr(spaces), hc: hc([...finishedOf(500), live])}, observedAt);
  const [project] = past.projects;
  assert.equal(project.status, 'unknown');
  assert.equal(project.agents, 0);
  assert.equal(project.unidentified, 1);
  assert.equal(project.counts.blocked, 0);
  assert.deepEqual(past.truncation.terminals, {limit: 500, total: 501, omitted: 1});
  assert.ok(truncationNotes(past).some(note => /下限/.test(note) && /身分與狀態會顯示為未知/.test(note)));
});

test('hc failure keeps ended unknown and does not claim terminal truncation', () => {
  const snapshot = normalizeSnapshot({herdr: herdr(spacesOf(1)), hc: {ok: false, error: 'timeout'}}, observedAt);
  assert.equal(snapshot.projects[0].ended, null);
  assert.equal(snapshot.projects[0].endedPartial, false);
  assert.equal(snapshot.truncation.terminals, null);
  assert.equal(endedLabel(snapshot.projects[0]), '未知（hc 無法讀取）');
});

test('a finished terminal named after an omitted project stays unattributed', () => {
  const spaces = spacesOf(101);
  spaces[100].name = 'P0';
  const snapshot = normalizeSnapshot({herdr: herdr(spaces), hc: hc(finishedOf(1))}, observedAt);
  assert.equal(snapshot.projects.find(p => p.id === 'sp0').ended, 0);
  assert.equal(snapshot.unattributedEnded, 1);
});

test('sub-agent counts over the per-terminal cap are reported as a lower bound', () => {
  const ids = n => Array.from({length: n}, (_, i) => `s${i}`);
  const at = n => normalizeSnapshot({herdr: herdr([{id: 'sp1', name: 'One', tabs: [{terminals: [term('t1', 'codex', 'working', {sub_agents: ids(n)})]}]}]), hc: hc([])}, observedAt);
  const full = at(50);
  assert.equal(full.projects[0].subAgents, 50);
  assert.equal(full.projects[0].subAgentsPartial, false);
  assert.equal(full.partial, false);
  assert.equal(subAgentsLabel(full.projects[0]), '50');
  const over = at(51);
  assert.equal(over.projects[0].subAgents, 50);
  assert.equal(over.projects[0].subAgentsPartial, true);
  assert.equal(over.partial, true);
  assert.deepEqual(over.truncation.subAgents, {limitPerTerminal: 50});
  assert.match(subAgentsLabel(over.projects[0]), /^至少 50/);
});

test('a source failure does not report truncation for data it never read', () => {
  const snapshot = normalizeSnapshot({herdr: {ok: false, error: 'timeout'}, hc: hc(finishedOf(10))}, observedAt);
  assert.equal(snapshot.partial, false);
  assert.equal(snapshot.truncation.projects, null);
});
