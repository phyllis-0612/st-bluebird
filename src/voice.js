// 第六段：按点击合成单条语音；凭据从梨园实时读取，不复制进青鸟。
import { ctx, getSettings } from './settings.js?v=0.6.3';
import { selectedContacts } from './contacts.js?v=0.6.3';
import { apiUrl } from './api.js?v=0.6.3';

const catalogs = { minimax: [], elevenlabs: [] };
let audioContext = null, currentSource = null, playSerial = 0, currentId = '';
const DB = 'bluebird-voice-cache', STORE = 'clips';
let dbPromise;
function openCache() {
    if (!globalThis.indexedDB) return Promise.resolve(null);
    if (!dbPromise) dbPromise = new Promise(resolve => {
        try {
            const request = indexedDB.open(DB, 1);
            request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'key' }); };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
            request.onblocked = () => resolve(null);
        } catch { resolve(null); }
    });
    return dbPromise;
}
async function cacheTransaction(mode, action) {
    const db = await openCache(); if (!db) return null;
    return new Promise(resolve => {
        try {
            const tx = db.transaction(STORE, mode), store = tx.objectStore(STORE), request = action(store);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
            tx.onabort = () => resolve(null);
        } catch { resolve(null); }
    });
}
export async function cachedClip(key) {
    const entry = await cacheTransaction('readonly', store => store.get(key));
    if (entry?.blob) { void cacheTransaction('readwrite', store => store.put({ ...entry, usedAt: Date.now() })); return entry.blob; }
    return null;
}
export async function saveClip(key, blob, maxMB = 200) {
    if (!blob?.size) return;
    await cacheTransaction('readwrite', store => store.put({ key, blob, size: blob.size, usedAt: Date.now() }));
    const entries = await cacheTransaction('readonly', store => store.getAll());
    if (!Array.isArray(entries)) return;
    let total = entries.reduce((n, e) => n + (e.size || 0), 0), max = maxMB * 1024 * 1024;
    for (const entry of entries.sort((a, b) => a.usedAt - b.usedAt)) {
        if (total <= max) break;
        await cacheTransaction('readwrite', store => store.delete(entry.key)); total -= entry.size || 0;
    }
}

export function voiceSource(provider, context = ctx(), settings = getSettings()) {
    const playhouse = context.extensionSettings?.playhouse;
    const external = provider === 'minimax' ? playhouse?.tts : playhouse?.tts?.elevenlabs;
    const local = provider === 'minimax' ? settings.ttsMiniMax : settings.ttsElevenLabs;
    return external?.apiKey ? { ...external, source: '梨园' } : local?.apiKey ? { ...local, source: '青鸟' } : { ...local, apiKey: '', source: '未配置' };
}

export function knownVoices(provider, context = ctx()) {
    const playhouse = context.extensionSettings?.playhouse;
    const list = provider === 'minimax' ? playhouse?.voiceBank : playhouse?.elevenLabsVoices?.voiceBank;
    const voices = Array.isArray(list) && list.length ? list : catalogs[provider] || [];
    return [...new Map(voices.filter(v => v?.voiceId).map(v => [v.voiceId, { voiceId: v.voiceId, label: v.label || v.voiceId }])).values()];
}

export async function loadVoiceCatalog(provider, context = ctx()) {
    const settings = voiceSource(provider, context);
    if (!settings.apiKey) return knownVoices(provider, context);
    if (provider === 'elevenlabs') {
        const voices = []; let token = '';
        for (let page = 0; page < 20; page++) {
            const url = new URL(apiUrl(settings.baseUrl, '/v2/voices'));
            if (token) url.searchParams.set('next_page_token', token);
            const response = await fetch(url, { headers: { 'xi-api-key': settings.apiKey } });
            const payload = await response.json().catch(() => null);
            if (!response.ok) throw new Error(payload?.detail?.message || `ElevenLabs 音色列表 HTTP ${response.status}`);
            voices.push(...(payload?.voices || []).filter(v => v.voice_id).map(v => ({ voiceId: v.voice_id, label: v.name || v.voice_id })));
            if (!payload?.has_more || !payload.next_page_token || payload.next_page_token === token) break;
            token = payload.next_page_token;
        }
        catalogs.elevenlabs = voices;
    } else {
        const response = await fetch(apiUrl(settings.baseUrl, '/v1/get_voice'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` }, body: JSON.stringify({ voice_type: 'all' }) });
        const payload = await response.json().catch(() => null);
        if (!response.ok || Number(payload?.base_resp?.status_code || 0)) throw new Error(payload?.base_resp?.status_msg || `MiniMax 音色列表 HTTP ${response.status}`);
        const arrays = [payload?.system_voice, payload?.voice_cloning, payload?.voice_generation, payload?.voices, payload?.data?.voices];
        catalogs.minimax = arrays.flatMap(v => Array.isArray(v) ? v : []).map(v => ({ voiceId: v.voice_id || v.voiceId, label: v.voice_name || v.name || v.voice_id || v.voiceId })).filter(v => v.voiceId);
    }
    return knownVoices(provider, context);
}

function voiceConfig(message, context = ctx()) {
    const provider = getSettings().voiceProvider;
    const voice = selectedContacts(context).find(c => c.name === message.sender)?.voice;
    const voiceId = voice?.[provider] || (voice?.provider === provider ? voice.voiceId : '');
    return { provider, voiceId };
}
export function voiceAvailability(message, context = ctx()) {
    const config = voiceConfig(message, context);
    if (!config.voiceId || !['minimax', 'elevenlabs'].includes(config.provider)) return { ready: false, reason: '未给这个联系人配置当前语音服务的音色' };
    const source = voiceSource(config.provider, context);
    if (!source.apiKey) return { ready: false, reason: `${config.provider === 'minimax' ? 'MiniMax' : 'ElevenLabs'} 未配置 Key` };
    return { ready: true, config, source };
}

function hexAudio(value) {
    if (typeof value !== 'string' || !value || value.length % 2 || /[^a-f0-9]/i.test(value)) throw new Error('MiniMax 没有返回有效音频');
    const bytes = new Uint8Array(value.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
    return new Blob([bytes], { type: 'audio/mpeg' });
}
export function synthesisRequest(message, config, source) {
    const speed = Math.max(0.5, Math.min(2, Number(source.globalSpeed || 1)));
    const tone = String(message.note || '').trim().toLowerCase();
    if (config.provider === 'elevenlabs') {
        if (!/^[\w-]+$/.test(config.voiceId)) throw new Error('ElevenLabs Voice ID 无效');
        const model = source.model || 'eleven_v4';
        const settings = { stability: Number(source.stability ?? 0.5), similarity_boost: Number(source.similarityBoost ?? 0.75) };
        if (!['eleven_v4', 'eleven_v4_turbo'].includes(model)) settings.speed = Math.max(0.7, Math.min(1.2, speed));
        const tags = { happy: 'happy', sad: 'sad', angry: 'angry', fearful: 'fearful', surprised: 'surprised', whisper: 'whispers' };
        const tag = ['eleven_v3', 'eleven_v4', 'eleven_v4_turbo'].includes(model) ? tags[tone] : null;
        const url = new URL(apiUrl(source.baseUrl || 'https://api.elevenlabs.io', `/v1/text-to-speech/${encodeURIComponent(config.voiceId)}`));
        url.searchParams.set('output_format', source.outputFormat || 'mp3_44100_128');
        return { url: url.href, body: { text: tag ? `[${tag}] ${message.content}` : message.content, model_id: model, voice_settings: settings }, headers: { 'Content-Type': 'application/json', 'xi-api-key': source.apiKey, Accept: 'audio/mpeg' } };
    }
    const model = source.model || 'speech-2.8-hd';
    const voice = { voice_id: config.voiceId, speed, vol: 1, pitch: 0 };
    const emotions = ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm'];
    if (/^speech-2\.[68]-/.test(model)) emotions.push('fluent');
    if (/^speech-2\.6-/.test(model)) emotions.push('whisper');
    if (emotions.includes(tone)) voice.emotion = tone;
    const url = new URL(apiUrl(source.baseUrl || 'https://api.minimaxi.com', '/v1/t2a_v2'));
    if (source.groupId) url.searchParams.set('GroupId', source.groupId);
    return { url: url.href, body: { model, text: message.content, stream: false, output_format: 'hex', language_boost: 'auto', voice_setting: voice,
        audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 } }, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${source.apiKey}` } };
}

export async function synthesizeVoice(message, context = ctx(), settings = getSettings()) {
    const available = voiceAvailability(message, context);
    if (!available.ready) return null;
    const request = synthesisRequest(message, available.config, available.source);
    // 包含服务地址和 Key 的摘要，避免不同账号/接口同名音色错误共用缓存；绝不存 Key 明文。
    let key = '';
    if (globalThis.crypto?.subtle && globalThis.TextEncoder) {
        const data = new TextEncoder().encode(JSON.stringify([available.config.provider, request.url, request.body, available.source.apiKey]));
        const digest = await crypto.subtle.digest('SHA-256', data);
        key = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
        const cached = await cachedClip(key); if (cached) return cached;
    }
    const response = await fetch(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body) });
    if (available.config.provider === 'elevenlabs') {
        if (!response.ok) { const payload = await response.json().catch(() => null); throw new Error(payload?.detail?.message || `ElevenLabs 合成 HTTP ${response.status}`); }
        const blob = await response.blob(); if (!blob.size) throw new Error('ElevenLabs 没有返回音频');
        if (key) await saveClip(key, blob, settings.voiceCacheMB); return blob;
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || Number(payload?.base_resp?.status_code || 0)) throw new Error(payload?.base_resp?.status_msg || `MiniMax 合成 HTTP ${response.status}`);
    const blob = hexAudio(payload?.data?.audio);
    if (key) await saveClip(key, blob, settings.voiceCacheMB); return blob;
}

export function unlockVoice() {
    const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Audio) throw new Error('浏览器不支持语音播放');
    if (!audioContext) audioContext = new Audio();
    const resumed = audioContext.resume();
    const silent = audioContext.createBufferSource();
    silent.buffer = audioContext.createBuffer(1, 1, audioContext.sampleRate);
    silent.connect(audioContext.destination); silent.start(0);
    return resumed;
}
export function stopVoice() {
    playSerial++; currentId = '';
    if (currentSource) { try { currentSource.stop(); } catch {} currentSource.disconnect(); currentSource = null; }
}
export function playingVoiceId() { return currentId; }
export async function playVoice(message) {
    stopVoice(); const serial = playSerial, id = message.id; currentId = id;
    const ready = unlockVoice(); // 同步执行在用户点击回调内，iOS 需要这个手势。
    await ready;
    const blob = await synthesizeVoice(message);
    if (!blob || serial !== playSerial) { if (serial === playSerial) currentId = ''; return false; }
    const buffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
    if (serial !== playSerial) return false;
    const source = audioContext.createBufferSource(); source.buffer = buffer; source.connect(audioContext.destination);
    currentSource = source; currentId = id;
    source.onended = () => { if (currentSource === source) { currentSource = null; currentId = ''; source.disconnect(); } };
    source.start(0); return true;
}
