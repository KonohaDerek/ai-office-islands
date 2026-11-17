// Normalized agent activity shown on the island map (issue #12). Only Herdr Core
// terminals carry program-reported status (OSC 7501); other sources stay unknown
// unless AI Office itself has a request in flight for that agent. A Herdr Core agent
// can also receive one explicit message per Send; these helpers decide when the
// composer is enabled and how a delivery outcome is described (never as a reply).
export const AGENT_STATUS_META = Object.freeze({
  working: {label: '工作中', tone: 'working'},
  idle: {label: '閒置', tone: 'idle'},
  blocked: {label: '等待協助', tone: 'blocked'},
  done: {label: '已完成', tone: 'done'},
  error: {label: '錯誤', tone: 'error'},
  unknown: {label: '狀態未知', tone: 'unknown'},
  offline: {label: '來源離線', tone: 'offline'},
});
export const AGENT_STATUS_LEGEND = Object.freeze(['working', 'idle', 'blocked', 'done', 'error', 'unknown', 'offline']);
const CORE_STATES = new Set(['idle', 'working', 'blocked', 'done', 'error']);
const LIVE_RUNTIMES = new Set(['Hermes', 'Grok', 'Claude', 'OpenAI', 'ClaudeOAuth', 'CodexOAuth']);

export function coreAgentState(value) {
  return typeof value === 'string' && CORE_STATES.has(value) ? value : 'unknown';
}

function status(state, detail, extra = {}) {
  return {state, ...AGENT_STATUS_META[state], detail, ...extra};
}

// bot: roster entry; context: {coreSources, activeRequests, providers, activeSource, publicDemo, sourcesLoading}
export function resolveAgentStatus(bot, context = {}) {
  const {coreSources = [], activeRequests = {}, providers = {}, activeSource = '', publicDemo = false, sourcesLoading = false} = context;
  if (!bot) return status('unknown', '沒有可用的狀態來源');
  if (bot.source === 'HerdrCore') {
    const source = coreSources.find(item => item.sourceKey === bot.coreSourceKey);
    if (!source || source.connection === 'offline' || source.connection === 'stopped') return status('offline', 'Herdr Core 本機來源未連線；顯示的不是目前狀態', {origin: 'HerdrCore'});
    if (source.connection === 'connecting') return status('unknown', '正在連線 Herdr Core 本機來源', {origin: 'HerdrCore'});
    const terminal = source.agents?.find(item => item.id === bot.id);
    if (!terminal) return status('unknown', 'Herdr Core 已不再回報此終端', {origin: 'HerdrCore'});
    const state = coreAgentState(terminal.status);
    const detail = state === 'unknown' ? (terminal.reported ? '程式回報的狀態不在支援範圍內' : '此程式未透過 OSC 7501 回報狀態') : '程式透過 OSC 7501 回報的狀態';
    return status(state, detail, {origin: 'HerdrCore', updatedAt: terminal.statusChangedAt || source.updatedAt || '', progress: Number.isInteger(terminal.progress) ? terminal.progress : null});
  }
  if (bot.codexReadOnly || bot.source === 'CodexCLI') return status('unknown', '唯讀封存紀錄，沒有即時狀態', {origin: 'CodexCLI', archived: true});
  if (activeRequests[bot.id] > 0) return status('working', 'AI Office 請求進行中', {origin: 'AI Office'});
  if (publicDemo || (!bot.source && !bot.runtimeSource && !bot.hermesProfileId && !activeSource)) return status('unknown', '示範角色，沒有即時狀態來源');
  const runtime = bot.hermesProfileId ? 'Hermes' : bot.runtimeSource || bot.source || activeSource;
  if (!sourcesLoading && LIVE_RUNTIMES.has(runtime) && providers[runtime] && !providers[runtime].connected) return status('offline', `${runtime} 未連線`, {origin: runtime});
  return status('unknown', '此來源未提供即時活動狀態；僅在 AI Office 請求進行時顯示工作中', {origin: runtime || ''});
}

export function formatStatusTime(value) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleTimeString('zh-TW', {hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false});
}

// Places observed Herdr Core terminals on points of the scene's walkable routes,
// spread evenly across every route so many terminals don't start stacked together.
export function coreMapBots(sources, routes = [], {avatars = ['character-engineer.png'], zone = 'main'} = {}) {
  const points = routes.flat().filter(point => Array.isArray(point) && point.length === 2);
  if (!points.length) points.push([50, 49]);
  const total = (sources || []).reduce((sum, source) => sum + (source.agents?.length || 0), 0);
  const step = Math.max(1, Math.floor(points.length / Math.max(1, total)));
  const bots = [];
  for (const source of sources || []) {
    for (const terminal of source.agents || []) {
      const index = bots.length, [x, y] = points[(index * step) % points.length];
      bots.push({
        id: terminal.id,
        // Only the server's generic agent-kind label or a neutral name; never a project or task name.
        name: typeof terminal.name === 'string' && terminal.name ? terminal.name : `Herdr Agent · ${terminal.address}`,
        role: `Herdr Core 終端 ${terminal.address}`,
        avatar: avatars[index % avatars.length],
        hue: (index * 47) % 360,
        x, y, zone,
        source: 'HerdrCore',
        coreSourceKey: source.sourceKey,
        coreAddress: terminal.address,
        coreObserved: true,
      });
    }
  }
  return bots;
}

// Why the Herdr Core composer is disabled, or '' when the user may send. The server re-checks everything.
export function coreComposerBlock(status, terminal) {
  if (!status || status.state === 'offline') return 'Herdr Core 本機來源未連線，無法傳送。';
  if (!terminal) return 'Herdr Core 已不再回報此終端，無法傳送。';
  if (status.state === 'blocked') return '程式正在等待協助（可能是權限、登入或問題對話）。請直接在該終端處理；AI Office 不會代為回答。';
  if (status.state === 'done') return '程式回報已完成；只有回報「閒置」或「工作中」的 Agent 可以接收訊息。';
  if (status.state === 'error') return '程式回報錯誤；請先在該終端確認狀況。';
  if (status.state !== 'idle' && status.state !== 'working') return '程式沒有回報可辨識的狀態，無法確認能否安全接收訊息。';
  if (!terminal.kind) return '此終端沒有回報可辨識的 Agent 類型，無法確認身分，因此停用傳送。';
  return '';
}

const CORE_SEND_REASONS = Object.freeze({
  unknown_target: '目標已不在 Herdr Core 的 repo 終端清單中。',
  invalid_text: '訊息不可為空、不可超過 4000 字，也不可包含控制字元。',
  invalid_message: '訊息格式不正確。',
  source_offline: 'Herdr Core 本機來源離線或狀態過舊。',
  blocked: '程式正在等待協助（權限、登入或問題對話），不會代為回答。',
  not_sendable_status: '程式目前不是「閒置」或「工作中」。',
  status_unknown: '程式沒有回報狀態。',
  unknown_app: '程式沒有回報可辨識的 Agent 類型。',
  unknown_identity: '無法從前景程式確認 Agent 身分。',
  ambiguous_identity: '前景程式身分不明確。',
  identity_mismatch: '前景程式與回報的 Agent 類型不一致。',
  label_mismatch: '終端已不再帶有 repo=ai-office-islands 標籤。',
  not_live: '終端已結束。',
  target_changed: '終端在傳送前已改變或消失。',
  send_in_progress: '此 Agent 已有一則訊息正在傳送。',
  unsupported_generation: 'Herdr Core 協定世代不相容。',
  send_unsupported: '此 Herdr Core 不支援傳送。',
  core_unavailable: '無法連線 Herdr Core。',
  status_mismatch: '傳送前程式狀態已改變，Herdr Core 沒有輸入。',
  finished: '終端已結束，Herdr Core 沒有輸入。',
  unavailable: 'Herdr Core 目前無法輸入到此終端。',
  not_found: 'Herdr Core 找不到此終端。',
  timeout: '等待 Herdr Core 回應逾時。',
  connection_lost: '傳送途中與 Herdr Core 的連線中斷。',
  core_uncertain: 'Herdr Core 回報傳送沒有完成（例如已取消），無法確認是否已輸入部分內容。',
  network: '無法取得本機服務的回應。',
});
const CHECK_FIRST = '請先在 Herdr Core 確認目標終端，再決定是否重新傳送；AI Office 不會自動重試。';

// entry: {delivery: 'sending'|'submitted'|'rejected'|'refused'|'uncertain', reason?, started?}
export function coreDeliveryText(entry) {
  const reason = CORE_SEND_REASONS[entry?.reason] || '';
  if (entry?.delivery === 'sending') return {tone: 'sending', label: '傳送中', detail: '等待 Herdr Core 確認是否已輸入。'};
  if (entry?.delivery === 'submitted') {
    const started = entry.started === true ? 'Core 回報程式隨後轉為「工作中」。' : entry.started === false ? 'Core 回報程式在數秒內沒有轉為「工作中」。' : '程式沒有回報是否開始處理。';
    return {tone: 'submitted', label: '已提交給 Herdr Core', detail: `${started}AI Office 不讀取終端輸出，因此不會顯示 Agent 回覆。`};
  }
  if (entry?.delivery === 'rejected') return {tone: 'failed', label: '未傳送', detail: `${reason || '傳送前檢查未通過。'}${CHECK_FIRST}`};
  if (entry?.delivery === 'refused') return {tone: 'failed', label: 'Herdr Core 拒絕輸入', detail: `${reason || 'Herdr Core 沒有輸入此訊息。'}${CHECK_FIRST}`};
  return {tone: 'uncertain', label: '結果不明', detail: `${reason || '無法確認訊息是否已輸入。'}訊息可能已經或尚未送達。${CHECK_FIRST}`};
}
