export function makeAgentSystemPrompt(agent, group, mode) {
  const rolePrompt = agent?.customPrompt || agent?.codexInstructions || '';
  const intent = mode === 'task'
    ? '使用者把一項工作明確交辦給你。先理解需求，提供可交付的成果；若你無法直接操作外部工具或檔案，清楚說明限制並交付下一步。'
    : '使用者邀請你加入群組討論。請直接回應前面成員的意見，補上你的專業觀點；不要假扮其他成員，也不要聲稱已執行未實際執行的工作。';
  return `你是「${agent.name}」，職責是「${agent.role}」，正在「${group.name}」群組中與其他 Agent 協作。${intent} 請以繁體中文回答，清楚說明你的結論與待辦。${rolePrompt ? `\n\n你的角色指示：\n${rolePrompt.slice(0, 5000)}` : ''}`;
}

export function makeDemoAgentReply(agent, mode, request) {
  const action = mode === 'task' ? '收到交辦' : '加入討論';
  const excerpt = request.length > 72 ? `${request.slice(0, 72)}…` : request;
  return `示範回覆：${agent.name}${action}：「${excerpt}」。這段只展示群組協作流程，尚未呼叫 AI 或執行外部工作。`;
}

export function taskStatusLabel(status) {
  return ({dispatching: '交辦中', responded: '已回覆', partial: '部分回覆', failed: '未完成', demo: '示範流程'})[status] || '準備交辦';
}

export function selectMentionedAgents(text, group, resolveAgent) {
  if (/(?:@all|全員|大家|各位|所有人)/i.test(text)) return group.members.map(resolveAgent).filter(Boolean);
  const normalized = text.toLocaleLowerCase();
  return group.members.map(resolveAgent).filter(agent => agent && normalized.includes(`@${agent.name.toLocaleLowerCase()}`));
}

export function inferCollaborationMode(text) {
  return /(交辦|請你|麻煩你|負責|處理|完成|製作|整理|撰寫|設計|修復|調查|分析|研究|查詢|搜尋|修改|產出|回報)/.test(text) ? 'task' : 'discussion';
}
