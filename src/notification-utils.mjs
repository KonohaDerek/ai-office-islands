export function isDuplicateNotification(items, candidate, now = Date.now()) {
  const maxAge = candidate.type === 'quota' ? 6 * 60 * 60 * 1000 : 30 * 1000;
  return items.some(item => item.officeId === candidate.officeId
    && item.type === candidate.type
    && item.title === candidate.title
    && item.targetId === candidate.targetId
    && now - Date.parse(item.createdAt) >= 0
    && now - Date.parse(item.createdAt) < maxAge);
}
