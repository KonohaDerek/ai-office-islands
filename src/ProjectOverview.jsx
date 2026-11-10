import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ArrowClockwise, CaretLeft, CaretRight, X} from '@phosphor-icons/react';
import {AGENT_LABELS, formatObservedTime, freshness, overviewErrorKind, sourceErrorLabel, statusMeta, summarizeProjects} from './project-overview-utils.mjs';

const ERROR_COPY = {
  offline: '裝置目前離線，無法讀取專案狀態。',
  'offline-service': '本機服務無法連線；狀態視為未知，不代表專案閒置或完成。',
  unavailable: '此伺服器未提供專案總覽（已停用或非本機開發環境）。',
  forbidden: '專案總覽僅限本機 loopback 存取。',
  error: '讀取專案狀態失敗；狀態視為未知。',
};
const SUMMARY_KEYS = ['blocked', 'review', 'waiting', 'unknown', 'working'];

function StatusPill({status}) {
  const meta = statusMeta(status);
  return <span className={`overview-status tone-${meta.tone}`}>{meta.label}</span>;
}

export default function ProjectOverview({open, onClose, publicDemo}) {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(false);
  const [errorKind, setErrorKind] = useState('');
  const [projectId, setProjectId] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const controllerRef = useRef(null);
  const panelRef = useRef(null);
  const returnFocusRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const load = useCallback((refresh = false) => {
    if (publicDemo || controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    fetch(`/api/project-overview${refresh ? '?refresh=1' : ''}`, {signal: controller.signal, cache: 'no-store'})
      .then(response => {
        if (!response.ok) throw Object.assign(new Error('overview request failed'), {status: response.status});
        return response.json();
      })
      .then(data => {
        if (controller.signal.aborted) return;
        setSnapshot(data);
        setErrorKind('');
        setNow(Date.now());
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        setErrorKind(overviewErrorKind({status: error.status, online: navigator.onLine}));
      })
      .finally(() => {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setLoading(false);
        }
      });
  }, [publicDemo]);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement;
    requestAnimationFrame(() => panelRef.current?.focus());
    load();
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    const offline = () => setErrorKind('offline');
    const online = () => load(true);
    const key = event => { if (event.key === 'Escape') onCloseRef.current(); };
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    document.addEventListener('keydown', key);
    return () => {
      clearInterval(tick);
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
      document.removeEventListener('keydown', key);
      controllerRef.current?.abort();
      controllerRef.current = null;
      setLoading(false);
      returnFocusRef.current?.focus?.();
    };
  }, [open, load]);

  if (!open) return null;
  const projects = Array.isArray(snapshot?.projects) ? snapshot.projects : [];
  const project = projectId ? projects.find(item => item.id === projectId) : null;
  const summary = summarizeProjects(projects);
  const fresh = snapshot ? freshness(snapshot.observedAt, now, snapshot.staleAfterMs) : 'unknown';
  const sources = Object.entries(snapshot?.sources || {});

  return <div className="overview-shade" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="project-overview" role="dialog" aria-modal="true" aria-labelledby="overview-title" tabIndex={-1} ref={panelRef}>
      <header className="overview-header">
        {project
          ? <button className="overview-back icon-button" type="button" onClick={() => setProjectId(null)} aria-label="返回專案列表"><CaretLeft size={18}/></button>
          : null}
        <div>
          <h2 id="overview-title">{project ? project.name : '專案總覽'}</h2>
          <p>{project ? '單一專案狀態' : publicDemo ? '公開展示 · 無真實資料' : 'Herdr 已登錄專案 · 本機唯讀'}</p>
        </div>
        {!publicDemo && <button className="overview-refresh icon-button" type="button" onClick={() => load(true)} disabled={loading} aria-label={loading ? '讀取中' : '重新整理'} title="重新整理"><ArrowClockwise size={17} className={loading ? 'spinning' : ''}/></button>}
        <button className="overview-close icon-button" type="button" onClick={onClose} aria-label="關閉專案總覽"><X size={19}/></button>
      </header>

      {publicDemo ? <div className="overview-empty"><strong>公開展示版不提供專案狀態</strong><small>專案總覽只在本機開發伺服器讀取 Herdr metadata；此展示版沒有任何真實專案資料。</small></div> : <>
        <div className={`overview-meta fresh-${fresh}`} aria-live="polite">
          <span><i/>{loading && !snapshot ? '讀取中…' : snapshot ? `觀測於 ${formatObservedTime(snapshot.observedAt)}` : '尚未取得資料'}{fresh === 'stale' ? ' · 資料可能過時' : ''}</span>
          <small>時間為伺服器觀測時間，並非專案工作更新時間。</small>
        </div>

        {errorKind && <div className="overview-alert" role="alert">
          <span>{ERROR_COPY[errorKind] || ERROR_COPY.error}{snapshot ? ' 以下為上次取得的資料。' : ''}</span>
          <button type="button" onClick={() => load(true)} disabled={loading}>重試</button>
        </div>}

        {sources.length > 0 && <ul className="overview-sources" aria-label="資料來源">
          {sources.map(([key, source]) => <li key={key} className={`source-${source.state === 'ok' ? 'ok' : 'error'}`}>
            <code>{key === 'herdr' ? 'herdr-app ls' : 'hc ls --all'}</code>
            <span>{source.state === 'ok' ? '正常' : `未知 · ${sourceErrorLabel(source.error)}`}</span>
          </li>)}
        </ul>}

        {project ? <div className="overview-detail">
          <div className="overview-detail-status"><StatusPill status={project.status}/><small>{statusMeta(project.status).detail}</small></div>
          <dl className="overview-counts">
            {SUMMARY_KEYS.map(key => <div key={key}><dt>{statusMeta(key).label}</dt><dd>{project.counts?.[key] ?? 0}</dd></div>)}
          </dl>
          <dl className="overview-facts">
            <div><dt>代理終端</dt><dd>{project.agents}{Object.entries(project.agentsByKind || {}).length ? ` · ${Object.entries(project.agentsByKind).map(([kind, count]) => `${AGENT_LABELS[kind] || kind} ${count}`).join('、')}` : ''}</dd></div>
            <div><dt>子代理</dt><dd>{project.subAgents}</dd></div>
            <div><dt>分頁</dt><dd>{project.tabs}</dd></div>
            <div><dt>一般終端</dt><dd>{project.shells}</dd></div>
            <div><dt>已結束終端</dt><dd>{project.ended}</dd></div>
            <div><dt>最後工作更新</dt><dd>未知（來源未提供）</dd></div>
          </dl>
          <p className="overview-note">代理回合結束不代表產品完成。此總覽不包含 PR、建置、部署或驗收資訊，也不讀取終端內容。</p>
        </div> : <>
          {snapshot?.available && <div className="overview-summary">
            {SUMMARY_KEYS.map(key => <span key={key} className={`tone-${statusMeta(key).tone}`}><b>{summary[key]}</b>{statusMeta(key).label}</span>)}
          </div>}
          {snapshot && !snapshot.available && <div className="overview-empty"><strong>專案清單未知</strong><small>無法從 Herdr 讀取已登錄專案；不代表沒有專案或專案已完成。</small></div>}
          {snapshot?.available && projects.length === 0 && <div className="overview-empty"><strong>沒有已登錄專案</strong><small>Herdr 目前沒有回報任何專案空間。</small></div>}
          {!snapshot && loading && <div className="overview-empty"><strong>讀取中…</strong></div>}
          <ul className="overview-list">
            {projects.map(item => <li key={item.id}>
              <button type="button" onClick={() => setProjectId(item.id)}>
                <span className="overview-project-copy">
                  <strong>{item.name}</strong>
                  <small>{item.agents ? `${item.agents} 個代理` : '沒有代理終端'}{item.counts?.blocked ? ` · ${item.counts.blocked} 受阻` : ''}{item.counts?.review ? ` · ${item.counts.review} 待確認` : ''}{item.counts?.waiting ? ` · ${item.counts.waiting} 待命` : ''}{item.counts?.working ? ` · ${item.counts.working} 進行中` : ''}{item.counts?.unknown ? ` · ${item.counts.unknown} 未知` : ''}</small>
                </span>
                <StatusPill status={item.status}/>
                <CaretRight size={14}/>
              </button>
            </li>)}
          </ul>
        </>}
        <p className="overview-footnote">僅限本機 loopback；手機透過網路遠端存取尚未驗證。</p>
      </>}
    </section>
  </div>;
}
