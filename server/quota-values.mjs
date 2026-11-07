export function finiteQuotaNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function clampQuotaPercent(value) {
  const number = finiteQuotaNumber(value);
  return number === null ? null : Math.max(0, Math.min(100, number));
}

export function quotaStatus(source) {
  if (!source.supported) return 'unsupported';
  if (source.quota?.available === false) return 'failed';
  const percentages = [
    ...(source.quota?.windows || []).map(window => clampQuotaPercent(window.remainingPercent)),
    clampQuotaPercent(source.quota?.spendLimit?.remainingPercent),
  ].filter(value => value !== null);
  if (!source.quota?.available || percentages.length === 0) return 'unknown';
  return percentages.some(value => value > 0) ? 'available' : 'exhausted';
}
