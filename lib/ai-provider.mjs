import { hash, id, now, store } from './core.mjs';

const defaultProvider = { id: 'provider_default', name: '默认 Provider', baseUrl: '', model: 'mergegraph-local-mock', timeoutMs: 60000, hasApiKey: false };
export function getProvider() {
  const value = store.get('providers', 'provider_default');
  return value ? { ...value, hasApiKey: Boolean(value.apiKey) } : defaultProvider;
}
export function saveProvider(input = {}) {
  const previous = store.get('providers', 'provider_default') || {};
  const value = store.put('providers', { ...previous, id: 'provider_default', name: String(input.name || previous.name || '默认 Provider'), baseUrl: String(input.baseUrl ?? previous.baseUrl ?? ''), model: String(input.model || previous.model || 'mergegraph-local-mock'), timeoutMs: Math.min(120000, Math.max(1000, Number(input.timeoutMs || previous.timeoutMs || 60000))), apiKey: input.apiKey && input.apiKey !== '••••••••' ? String(input.apiKey) : String(previous.apiKey || ''), updatedAt: now() });
  return { ...value, hasApiKey: Boolean(value.apiKey), apiKey: undefined };
}

function extractJson(content) {
  if (typeof content === 'object' && content) return content;
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(text); } catch { const match = text.match(/\{[\s\S]*\}/); try { return match ? JSON.parse(match[0]) : null; } catch { return null; } }
}

function localPlan(prompt, context) {
  const requestedPath = String(prompt).match(/(?:文件|file)\s*[：:]?\s*([\w./\\-]+\.[\w]+)/i)?.[1] || 'README.md';
  const title = String(prompt).slice(0, 100);
  return { plan: [{ id: id('step'), title: `分析并执行：${title}`, files: [requestedPath], validation: ['node --check'] }], operations: [], summary: '本地 Provider 已生成任务计划。配置 OpenAI-compatible Provider 后可生成并应用结构化文件补丁。', provider: 'local-mock', contextHash: hash(JSON.stringify(context || {})) };
}

export async function runStructured(prompt, context = {}, { signal } = {}) {
  const provider = getProvider();
  if (!provider.baseUrl) return localPlan(prompt, context);
  const endpoint = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const instruction = `你是 MergeGraph 的本地代码任务执行器。只返回 JSON，不要 Markdown，不要 shell 字符串。JSON 结构：{"plan":[{"id":"step_1","title":"...","files":["相对路径"],"validation":["node --check 文件"]}],"operations":[{"path":"相对路径","action":"create|replace|patch|delete","content":"完整文件内容或 unified diff"}],"summary":"..."}。只能修改工作区内文件。用户要求：${prompt}`;
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) }, signal: signal || AbortSignal.timeout(provider.timeoutMs), body: JSON.stringify({ model: provider.model, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: instruction }, { role: 'user', content: JSON.stringify({ prompt, context }) }] }) });
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content || payload?.output_text || payload;
  const result = extractJson(content);
  if (!result || !Array.isArray(result.operations) || !Array.isArray(result.plan)) throw new Error('Provider response is not a valid structured task plan');
  return { ...result, provider: provider.model, contextHash: hash(JSON.stringify(context || {})) };
}
