const liveRuntimeSources = new Set(['Hermes', 'Grok', 'Claude', 'OpenAI', 'ClaudeOAuth', 'CodexOAuth']);

export function initialRoleRuntimeSource(activeSource, providers) {
  return liveRuntimeSources.has(activeSource) && providers?.[activeSource]?.connected ? activeSource : '';
}

export function resolveRoleRuntimeSource(preferredSource, officeSource) {
  return liveRuntimeSources.has(preferredSource) ? preferredSource : officeSource;
}

export function quotaSourceSignature(providers, cliSources) {
  const api = Object.entries(providers || {})
    .filter(([, source]) => source?.connected || source?.saved)
    .map(([id, source]) => id + ':' + (source.connected ? 'connected' : 'saved'))
    .sort();
  const cli = Object.entries(cliSources || {})
    .filter(([, source]) => source?.loggedIn)
    .map(([id]) => id + ':logged-in')
    .sort();
  return [...api, ...cli].join('|');
}

export function formatQuotaDate(value) {
  if (value === null || value === undefined || value === '') return '供應商未提供';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '供應商未提供' : date.toLocaleString('zh-TW', {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
}
