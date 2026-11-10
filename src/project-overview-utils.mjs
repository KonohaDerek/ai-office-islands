// Display helpers for the read-only project overview (issue #8).
export const STATUS_META = {
  blocked: {label: '受阻', detail: '需要處理', tone: 'blocked'},
  review: {label: '回合結束', detail: '待人工確認；不代表產品完成', tone: 'waiting'},
  waiting: {label: '待命', detail: '等待指示', tone: 'waiting'},
  unknown: {label: '狀態未知', detail: '來源未回報狀態', tone: 'unknown'},
  working: {label: '進行中', detail: '代理回合執行中', tone: 'working'},
  none: {label: '沒有代理', detail: '只有一般終端或尚無終端', tone: 'neutral'},
};

export const AGENT_LABELS = {'claude-code': 'Claude Code', codex: 'Codex', hermes: 'Hermes'};

const SOURCE_ERRORS = {
  not_found: '找不到指令',
  timeout: '逾時',
  output_too_large: '輸出過大',
  invalid_output: '輸出格式無法辨識',
  not_run: '未執行',
  not_allowed: '不允許的指令',
  failed: '執行失敗',
};

export function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.unknown;
}

export function sourceErrorLabel(code) {
  return SOURCE_ERRORS[code] || SOURCE_ERRORS.failed;
}

// fresh | stale | unknown, judged from observation time (sources give no update time).
export function freshness(observedAt, now = Date.now(), staleAfterMs = 60_000) {
  const time = typeof observedAt === 'string' ? Date.parse(observedAt) : NaN;
  if (!Number.isFinite(time) || !Number.isFinite(staleAfterMs)) return 'unknown';
  return now - time > staleAfterMs ? 'stale' : 'fresh';
}

export function summarizeProjects(projects = []) {
  const summary = {blocked: 0, review: 0, waiting: 0, unknown: 0, working: 0, none: 0};
  for (const project of projects) summary[Object.hasOwn(summary, project?.status) ? project.status : 'unknown'] += 1;
  return summary;
}

// Maps a failed fetch to a user-facing state: offline | unavailable | forbidden | error.
export function overviewErrorKind({status, online = true} = {}) {
  if (!online) return 'offline';
  if (status === 404) return 'unavailable';
  if (status === 403 || status === 405) return 'forbidden';
  if (status === undefined) return 'offline-service';
  return 'error';
}

export function formatObservedTime(observedAt) {
  const time = typeof observedAt === 'string' ? new Date(observedAt) : null;
  if (!time || Number.isNaN(time.valueOf())) return '未知時間';
  return time.toLocaleString('zh-TW', {year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false});
}

// null/undefined means the source could not say; never render it as 0.
export function countLabel(value) {
  return value === null || value === undefined ? '未知（hc 無法讀取）' : String(value);
}

export function agentSummaryLabel(project = {}) {
  const agents = project.agents || 0, unidentified = project.unidentified || 0;
  if (!agents) return unidentified ? '代理身分未知' : '沒有代理終端';
  return `${agents} 個代理${unidentified ? ` · ${unidentified} 個身分未知` : ''}`;
}

export function unattributedEndedNote(snapshot) {
  if (!snapshot?.available) return '';
  const count = snapshot.unattributedEnded;
  if (count === null || count === undefined) return '已結束終端數未知：hc 無法讀取，無法判斷各專案已結束的終端。';
  return count > 0 ? `另有 ${count} 個已結束終端無法對應到單一專案。` : '';
}

// Focus-trap decision for Tab: returns the element to move focus to, or null to let Tab proceed.
export function focusTrapTarget({items = [], active, inside, shiftKey, panel}) {
  if (!items.length) return panel ?? null;
  const first = items[0], last = items[items.length - 1];
  if (!inside) return shiftKey ? last : first;
  if (shiftKey && (active === first || active === panel)) return last;
  if (!shiftKey && active === last) return first;
  return null;
}
