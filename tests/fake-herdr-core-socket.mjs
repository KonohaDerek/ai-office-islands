// A fake Herdr Core socket for tests: JSON-RPC 2.0, one message per line, protocol
// generation 1. It implements the status methods plus terminal.get and terminal.send
// (with Core's `force` and `if` rules), records every method and parameter it receives so
// tests can prove nothing else was sent, and never runs or types into a real program.
import net from 'node:net';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

// A live terminal record labelled for this repo. Name, title, argv, cwd, foreground,
// labels and the status message carry text that must never be retained or displayed.
export const REPO_LABELS = Object.freeze({repo: 'ai-office-islands'});
export const terminal = (address, status, extra = {}) => ({
  address, labels: {...REPO_LABELS, task: 'secret-task-label'}, argv: ['claude', '--secret-flag'], cwd: '/Users/someone/secret-project', state: 'live',
  created_ms: 1, screen: 'exact', cols: 80, rows: 24, name: 'secret-project-name', title: 'working on secret task',
  foreground: {pid: 10, name: 'node', argv: ['node', 'busy.js'], cwd: '/Users/someone/secret-project'},
  status: status ? {state: status, app: 'claude', msg: 'secret status message', title: 'secret status title'} : null,
  reported: Boolean(status), records: {other: {state: 'working', msg: 'secret record message'}}, turn: 0, ...extra,
});

// The foreground of a recognized agent program; its argv and cwd are still never retained.
export const agentForeground = (name = 'claude') => ({pid: 11, name, argv: [name, '--secret-flag'], cwd: '/Users/someone/secret-project'});
// A repo terminal running a recognized agent that reports a sendable status.
export const agentTerminal = (address, status = 'idle', extra = {}) => terminal(address, status, {foreground: agentForeground(), ...extra});

// A company-like terminal that must never pass the repo label filter.
export const companyTerminal = (address = 't99') => terminal(address, 'working', {
  name: 'acme-corp-billing', labels: {repo: 'acme-corp-internal', client: 'Acme Corp'}, title: 'Acme Corp payroll export', cwd: '/Users/someone/acme-corp',
  status: {state: 'working', app: 'claude', msg: 'Acme Corp confidential'},
});

const matches = (labels, filter) => Object.entries(filter || {}).every(([key, value]) => labels?.[key] === value);

export async function startFakeCore({terminals = [], generation = 1, socketPath: existingPath} = {}) {
  const dir = existingPath ? dirname(existingPath) : await mkdtemp(join(tmpdir(), 'aio-hc-'));
  const socketPath = existingPath || join(dir, 'default.sock');
  // sendBehavior: 'type' (default), a Core error kind to refuse with, 'hang' (never answers) or 'close' (drops the connection).
  // beforeSend runs between terminal.get and terminal.send so tests can change a target mid-flight.
  const state = {terminals, generation, seq: 100, methods: [], requests: [], subscribeParams: [], subscribers: new Map(), sockets: new Set(), typed: [], sendBehavior: 'type', beforeSend: null, sendResult: {started: true}};
  const write = (socket, message) => socket.write(JSON.stringify({jsonrpc: '2.0', ...message}) + '\n');
  const server = net.createServer(socket => {
    state.sockets.add(socket);
    socket.on('close', () => { state.sockets.delete(socket); state.subscribers.delete(socket); });
    socket.on('error', () => {});
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let request;
        try { request = JSON.parse(line); } catch { write(socket, {id: null, error: {code: -32700, message: 'parse error', data: {kind: 'parse'}}}); continue; }
        state.methods.push(request.method);
        state.requests.push({method: request.method, params: request.params});
        const reply = result => write(socket, {id: request.id, result});
        const fail = kind => write(socket, {id: request.id, error: {code: -32000, message: kind, data: {kind}}});
        if (request.jsonrpc !== '2.0') fail('invalid_request');
        else if (request.method === 'hello') {
          if (request.params?.generation !== undefined && request.params.generation !== state.generation) fail('unsupported_generation');
          else reply({generation: state.generation, version: '0.1.20', core: {id: 'core-test', name: 'test'}, framed: false, methods: ['hello', 'terminal.list', 'terminal.get', 'terminal.send', 'events.subscribe', 'terminal.read'], features: []});
        } else if (request.method === 'terminal.list') reply({terminals: state.terminals, hidden_finished: 0, machines: []});
        else if (request.method === 'terminal.get') {
          const found = state.terminals.find(item => item.address === request.params?.terminal);
          if (found) reply(found); else fail('not_found');
        } else if (request.method === 'terminal.send') {
          state.beforeSend?.(state);
          const params = request.params || {}, found = state.terminals.find(item => item.address === params.terminal);
          const status = found?.status?.state ?? null;
          if (state.sendBehavior === 'hang') continue;
          if (state.sendBehavior === 'close') { socket.destroy(); continue; }
          if (state.sendBehavior !== 'type') fail(state.sendBehavior);
          else if (!found) fail('not_found');
          else if (found.state !== 'live') fail('finished');
          else if (typeof params.text !== 'string') fail('invalid_params');
          else if (status === 'blocked' && params.force !== true) fail('blocked');
          else if (params.if !== undefined && params.if !== null && params.if !== status) fail('status_mismatch');
          else { state.typed.push({terminal: params.terminal, text: params.text}); reply({turn: 1, status, ...state.sendResult}); }
        }
        else if (request.method === 'events.subscribe') {
          // Honors Core's label filter the way the real core does: snapshot and events only for matching terminals.
          const filter = request.params?.labels || {};
          state.subscribeParams.push(request.params);
          state.subscribers.set(socket, filter);
          reply({seq: state.seq, terminals: state.terminals.filter(item => matches(item.labels, filter))});
        }
        else fail('method_not_allowed_in_fake');
      }
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  const labelsOf = address => state.terminals.find(item => item.address === address)?.labels;
  const notify = (message, address) => {
    for (const [socket, filter] of state.subscribers) if (!socket.destroyed && (address === undefined || matches(labelsOf(address), filter))) write(socket, message);
  };
  return {
    socketPath, state,
    // Emits a Core `event` notification with the next sequence number.
    event(type, address, data, {skip = 0} = {}) {
      state.seq += 1 + skip;
      // Like Core, every subscriber's seq advances; filtered-out events are simply not delivered.
      const labels = type === 'created' ? data?.labels : labelsOf(address);
      for (const [socket, filter] of state.subscribers) {
        if (socket.destroyed) continue;
        const visible = matches(labels, filter) || (type === 'labels' && matches(labelsOf(address), filter) !== matches(data?.labels, filter));
        if (visible) write(socket, {method: 'event', params: {seq: state.seq, type, terminal: address, data}});
      }
    },
    setStatus(address, status, {reported = true} = {}) {
      const value = status ? {state: status, app: 'claude', msg: 'secret status message'} : null;
      state.terminals = state.terminals.map(item => item.address === address ? {...item, status: value, reported} : item);
      this.event('status', address, {status: value, records: {}, reported});
    },
    heartbeat(seq = state.seq) { notify({method: 'heartbeat', params: {seq}}); },
    missed() {
      state.seq += 5;
      for (const [socket, filter] of state.subscribers) if (!socket.destroyed) write(socket, {method: 'missed', params: {seq: state.seq, terminals: state.terminals.filter(item => matches(item.labels, filter))}});
    },
    raw(text) { for (const socket of state.subscribers.keys()) socket.write(text); },
    subscriberCount: () => [...state.subscribers].filter(socket => !socket.destroyed).length,
    async close({keepDir = false} = {}) {
      for (const socket of state.sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      if (!keepDir) await rm(dir, {recursive: true, force: true});
    },
    // Simulates the core restarting on the same endpoint; its seq starts over.
    restart: () => startFakeCore({terminals: state.terminals, generation: state.generation, socketPath}),
  };
}
