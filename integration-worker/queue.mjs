import {
  INSTALLATION_LIMIT_PER_HOUR,
  LEASE_MS,
  MAX_ATTEMPTS,
  SOURCE_LIMIT_PER_HOUR,
  TASK_RETENTION_MS,
  sealDeliveryToken,
} from './core.mjs';

const jsonHeaders = {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {status, headers: jsonHeaders});
}

function asTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    sourceId: row.source_id,
    userId: row.user_id,
    guildId: row.guild_id,
    agentId: row.agent_id,
    intent: row.intent,
    prompt: row.prompt,
    status: row.status,
    attempt: row.attempt,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export class TaskQueue {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec('PRAGMA foreign_keys = ON');
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        event_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        guild_id TEXT,
        agent_id TEXT NOT NULL,
        intent TEXT NOT NULL CHECK (intent IN ('ask', 'task')),
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL,
        lease_token TEXT,
        lease_until INTEGER,
        result TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        UNIQUE(source, event_id)
      );
      CREATE INDEX IF NOT EXISTS tasks_queue_idx ON tasks(status, available_at, created_at);
      CREATE INDEX IF NOT EXISTS tasks_expiry_idx ON tasks(expires_at);
      CREATE TABLE IF NOT EXISTS deliveries (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        application_id TEXT,
        sealed_token TEXT,
        expires_at INTEGER,
        status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS rate_limits (
        limit_key TEXT NOT NULL,
        bucket_start INTEGER NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY(limit_key, bucket_start)
      );
    `);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (request.method === 'POST' && path === '/tasks') return await this.enqueue(request);
      if (request.method === 'POST' && path === '/claim') return this.claim();
      const taskPath = path.match(/^\/tasks\/([0-9a-f-]{36})(?:\/(renew|complete|fail|delivery|delivery-status))?$/i);
      if (!taskPath) return json({error: 'Not found'}, 404);
      const [, taskId, action] = taskPath;
      if (request.method === 'POST' && action === 'renew') return await this.renew(taskId, request);
      if (request.method === 'POST' && action === 'complete') return await this.finish(taskId, request, 'completed');
      if (request.method === 'POST' && action === 'fail') return await this.fail(taskId, request);
      if (request.method === 'GET' && action === 'delivery') return this.delivery(taskId);
      if (request.method === 'POST' && action === 'delivery-status') return await this.deliveryStatus(taskId, request);
      return json({error: 'Method not allowed'}, 405);
    } catch (error) {
      return json({error: error?.message || 'Queue operation failed'}, 400);
    }
  }

  async enqueue(request) {
    const input = await request.json();
    const task = input?.task;
    if (!task || !['telegram', 'discord'].includes(task.source) || !task.eventId || !task.sourceId || !task.userId || !task.agentId || !task.prompt) {
      return json({error: 'Invalid task envelope'}, 400);
    }
    let sealedToken = null;
    let deliveryExpiry = null;
    if (input.delivery?.token) {
      try {
        sealedToken = await sealDeliveryToken(input.delivery.token, this.env.DELIVERY_TOKEN_KEY);
      } catch {
        return json({error: 'Delivery token encryption is not configured'}, 503);
      }
      deliveryExpiry = Number(input.delivery.expiresAt);
      if (!Number.isSafeInteger(deliveryExpiry) || deliveryExpiry <= Date.now()) return json({error: 'Invalid delivery token expiry'}, 400);
    }

    const now = Date.now();
    const bucketStart = Math.floor(now / 3_600_000) * 3_600_000;
    const taskId = crypto.randomUUID();
    let outcome;
    this.ctx.storage.transactionSync(() => {
      const existing = this.sql.exec('SELECT id, status FROM tasks WHERE source = ? AND event_id = ?', task.source, task.eventId).toArray()[0];
      if (existing) {
        outcome = {created: false, id: existing.id, status: existing.status};
        return;
      }

      const sourceLimitKey = 'source:' + task.source + ':' + task.sourceId;
      const sourceCount = this.rateCount(sourceLimitKey, bucketStart);
      const installationCount = this.rateCount('installation', bucketStart);
      if (sourceCount >= SOURCE_LIMIT_PER_HOUR || installationCount >= INSTALLATION_LIMIT_PER_HOUR) {
        outcome = {rateLimited: true};
        return;
      }
      this.bumpRate(sourceLimitKey, bucketStart);
      this.bumpRate('installation', bucketStart);
      this.sql.exec(`INSERT INTO tasks (
        id, source, event_id, source_id, user_id, guild_id, agent_id, intent, prompt,
        status, attempt, available_at, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
      taskId, task.source, task.eventId, task.sourceId, task.userId, task.guildId || null, task.agentId, task.intent, task.prompt,
      now, now, now, now + TASK_RETENTION_MS);
      this.sql.exec(`INSERT INTO deliveries (task_id, source, source_id, application_id, sealed_token, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)`, taskId, task.source, task.sourceId, input.delivery?.applicationId || null, sealedToken, deliveryExpiry);
      outcome = {created: true, id: taskId, status: 'queued'};
    });

    if (outcome.rateLimited) return json({error: 'Rate limit exceeded'}, 429);
    await this.scheduleCleanup();
    return json(outcome, outcome.created ? 201 : 200);
  }

  rateCount(key, bucketStart) {
    return Number(this.sql.exec('SELECT count FROM rate_limits WHERE limit_key = ? AND bucket_start = ?', key, bucketStart).toArray()[0]?.count || 0);
  }

  bumpRate(key, bucketStart) {
    this.sql.exec(`INSERT INTO rate_limits (limit_key, bucket_start, count) VALUES (?, ?, 1)
      ON CONFLICT(limit_key, bucket_start) DO UPDATE SET count = count + 1`, key, bucketStart);
  }

  claim() {
    const now = Date.now();
    const expired = [];
    let outcome = null;
    this.ctx.storage.transactionSync(() => {
      const timedOut = this.sql.exec(`SELECT id, attempt FROM tasks WHERE status = 'leased' AND lease_until <= ?`, now).toArray();
      for (const task of timedOut) {
        if (task.attempt >= MAX_ATTEMPTS) {
          this.sql.exec(`UPDATE tasks SET status = 'delivery_pending', error = ?, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`, 'Bridge lease expired after maximum attempts', now, task.id);
          expired.push(task.id);
        } else {
          const backoff = Math.min(30_000, 2 ** task.attempt * 2_000);
          this.sql.exec(`UPDATE tasks SET status = 'queued', available_at = ?, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`, now + backoff, now, task.id);
        }
      }

      const next = this.sql.exec(`SELECT * FROM tasks WHERE status = 'queued' AND available_at <= ? AND expires_at > ? ORDER BY created_at LIMIT 1`, now, now).toArray()[0];
      if (!next) return;
      const leaseToken = crypto.randomUUID();
      this.sql.exec(`UPDATE tasks SET status = 'leased', attempt = attempt + 1, lease_token = ?, lease_until = ?, updated_at = ? WHERE id = ? AND status = 'queued'`, leaseToken, now + LEASE_MS, now, next.id);
      outcome = {task: {...asTask(next), status: 'leased', attempt: next.attempt + 1, leaseToken, leaseUntil: now + LEASE_MS}, expired};
    });
    return json(outcome || {task: null, expired});
  }

  async renew(taskId, request) {
    const input = await request.json();
    const now = Date.now();
    let changed = 0;
    this.ctx.storage.transactionSync(() => {
      const result = this.sql.exec(`UPDATE tasks SET lease_until = ?, updated_at = ?
        WHERE id = ? AND status = 'leased' AND lease_token = ? AND lease_until > ?`, now + LEASE_MS, now, taskId, input.leaseToken || '', now);
      changed = result.rowsWritten;
    });
    return changed ? json({renewed: true, leaseUntil: now + LEASE_MS}) : json({error: 'Lease is not active'}, 409);
  }

  async finish(taskId, request, status) {
    const input = await request.json();
    if (typeof input.result !== 'string' || input.result.length > MAX_RESULT_CHARS) return json({error: 'Result must be text of 8000 characters or less'}, 400);
    const updated = this.setTerminal(taskId, input.leaseToken, status, input.result, null);
    return updated ? json({accepted: true, status: 'delivery_pending'}) : json({error: 'Lease is not active'}, 409);
  }

  async fail(taskId, request) {
    const input = await request.json();
    const now = Date.now();
    let outcome = null;
    this.ctx.storage.transactionSync(() => {
      const task = this.sql.exec(`SELECT * FROM tasks WHERE id = ? AND status = 'leased' AND lease_token = ? AND lease_until > ?`, taskId, input.leaseToken || '', now).toArray()[0];
      if (!task) return;
      if (input.retryable === true && task.attempt < MAX_ATTEMPTS && task.expires_at > now) {
        const backoff = Math.min(30_000, 2 ** task.attempt * 2_000);
        this.sql.exec(`UPDATE tasks SET status = 'queued', available_at = ?, lease_token = NULL, lease_until = NULL, error = ?, updated_at = ? WHERE id = ?`, now + backoff, String(input.error || 'Agent execution failed').slice(0, 500), now, taskId);
        outcome = {accepted: true, status: 'queued'};
      } else {
        this.sql.exec(`UPDATE tasks SET status = 'delivery_pending', error = ?, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`, String(input.error || 'Agent execution failed').slice(0, 500), now, taskId);
        outcome = {accepted: true, status: 'delivery_pending'};
      }
    });
    return outcome ? json(outcome) : json({error: 'Lease is not active'}, 409);
  }

  setTerminal(taskId, leaseToken, status, result, error) {
    const now = Date.now();
    let changed = 0;
    this.ctx.storage.transactionSync(() => {
      const update = this.sql.exec(`UPDATE tasks SET status = 'delivery_pending', result = ?, error = ?, lease_token = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'leased' AND lease_token = ? AND lease_until > ?`, result, error, now, taskId, leaseToken || '', now);
      changed = update.rowsWritten;
      if (changed && status !== 'completed') this.sql.exec(`UPDATE tasks SET error = ? WHERE id = ?`, error, taskId);
    });
    return changed > 0;
  }

  delivery(taskId) {
    const task = this.sql.exec('SELECT * FROM tasks WHERE id = ?', taskId).toArray()[0];
    const delivery = this.sql.exec('SELECT * FROM deliveries WHERE task_id = ?', taskId).toArray()[0];
    if (!task || !delivery || task.status !== 'delivery_pending') return json({error: 'Delivery is not pending'}, 404);
    return json({
      task: asTask(task),
      delivery: {
        source: delivery.source,
        sourceId: delivery.source_id,
        applicationId: delivery.application_id,
        sealedToken: delivery.sealed_token,
        expiresAt: delivery.expires_at,
      },
    });
  }

  async deliveryStatus(taskId, request) {
    const input = await request.json();
    let result = null;
    this.ctx.storage.transactionSync(() => {
      const task = this.sql.exec('SELECT status, error FROM tasks WHERE id = ?', taskId).toArray()[0];
      if (!task || task.status !== 'delivery_pending') return;
      const status = input.delivered === true ? (task.error ? 'failed' : 'completed') : 'delivery_failed';
      this.sql.exec('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?', status, Date.now(), taskId);
      this.sql.exec('UPDATE deliveries SET status = ? WHERE task_id = ?', status === 'completed' ? 'delivered' : 'failed', taskId);
      this.sql.exec('DELETE FROM deliveries WHERE task_id = ?', taskId);
      result = {status};
    });
    return result ? json(result) : json({error: 'Delivery is no longer pending'}, 409);
  }

  async scheduleCleanup() {
    if (typeof this.ctx.storage.setAlarm === 'function') await this.ctx.storage.setAlarm(Date.now() + 15 * 60 * 1000);
  }

  async alarm() {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM tasks WHERE expires_at <= ?', now);
      this.sql.exec('DELETE FROM deliveries WHERE expires_at IS NOT NULL AND expires_at <= ?', now);
      this.sql.exec('DELETE FROM rate_limits WHERE bucket_start < ?', Math.floor((now - 24 * 60 * 60 * 1000) / 3_600_000) * 3_600_000);
    });
    const nextExpiry = this.sql.exec('SELECT MIN(expires_at) AS next_expiry FROM tasks').toArray()[0]?.next_expiry;
    if (nextExpiry && typeof this.ctx.storage.setAlarm === 'function') await this.ctx.storage.setAlarm(Math.min(nextExpiry, now + 24 * 60 * 60 * 1000));
  }
}
