// 青鸟独立的聊天补全预设；默认仍跟随酒馆现有连接。
import { ctx, getSettings, setSetting } from './settings.js?v=0.6.0';

export function activeApiPreset(settings = getSettings()) {
    return (settings.apiPresets || []).find(item => item.id === settings.activeApiPresetId) || null;
}

export function apiUrl(base, suffix) {
    const url = new URL(String(base || '').trim());
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('API 地址需要 HTTPS（本机 localhost 可以用 HTTP）');
    const path = url.pathname.replace(/\/+$/, '').replace(/\/v1\/(?:chat\/completions|models)$/i, '/v1');
    url.pathname = /\/v1$/i.test(path) ? `${path}${suffix.replace(/^\/v1/, '')}` : `${path}${suffix}`;
    url.search = ''; url.hash = '';
    return url.href;
}

export function saveApiPresets(presets, activeId) {
    const clean = presets.filter(p => p && typeof p.id === 'string' && typeof p.name === 'string').map(p => ({
        id: p.id, name: p.name.trim() || '未命名预设', baseUrl: String(p.baseUrl || '').trim(),
        apiKey: String(p.apiKey || '').trim(), model: String(p.model || '').trim(),
    }));
    setSetting('apiPresets', clean);
    setSetting('activeApiPresetId', clean.some(p => p.id === activeId) ? activeId : 'tavern');
}

export async function requestBluebirdRaw(context, request, settings = getSettings()) {
    const preset = activeApiPreset(settings);
    if (preset) {
        if (!preset.baseUrl || !preset.apiKey || !preset.model) throw new Error('请先填好青鸟 API 预设的地址、Key 和模型');
        const url = apiUrl(preset.baseUrl, '/v1/chat/completions');
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${preset.apiKey}` },
            body: JSON.stringify({ model: preset.model, messages: [{ role: 'system', content: request.systemPrompt }, { role: 'user', content: request.prompt }],
                max_tokens: request.responseLength || 1024, temperature: request.temperature ?? 0.7 }) });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error?.message || `青鸟 API HTTP ${response.status}`);
        const content = payload?.choices?.[0]?.message?.content;
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(p => p.text || '').join('') : '';
        if (!text) throw new Error('青鸟 API 没有返回文本');
        return text;
    }
    if (typeof context.generateRaw !== 'function') throw new Error('当前酒馆缺少 generateRaw，请更新酒馆');
    const events = context.eventTypes || context.event_types || {};
    let hook = null;
    if (settings.phoneModel) {
        if (context.mainApi !== 'openai' || !events.CHAT_COMPLETION_SETTINGS_READY) throw new Error('独立模型需使用酒馆聊天补全连接；也可以清空手机模型跟随当前连接');
        const marker = `[青鸟请求:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}]`;
        request = { ...request, systemPrompt: request.systemPrompt + '\n' + marker };
        hook = data => { if (Array.isArray(data.messages) && data.messages.some(m => JSON.stringify(m.content).includes(marker))) data.model = settings.phoneModel; };
        context.eventSource.on(events.CHAT_COMPLETION_SETTINGS_READY, hook);
    }
    try { return await context.generateRaw(request); }
    finally { if (hook) context.eventSource.removeListener(events.CHAT_COMPLETION_SETTINGS_READY, hook); }
}

export async function listApiModels(preset) {
    if (!preset?.baseUrl || !preset?.apiKey) throw new Error('先填写地址和 Key');
    const response = await fetch(apiUrl(preset.baseUrl, '/v1/models'), { headers: { Authorization: `Bearer ${preset.apiKey}` } });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message || `模型列表 HTTP ${response.status}`);
    return (payload?.data || []).map(item => item?.id).filter(Boolean).sort();
}
