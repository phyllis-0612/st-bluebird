import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
const source = name => fs.readFileSync(new URL(`../src/${name}.js`, import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export /g, '');
const bytes = new Blob([Uint8Array.of(1, 2, 3)], { type: 'audio/mpeg' });

function memoryDB() {
    const map = new Map();
    const request = result => { const op = { result }; queueMicrotask(() => op.onsuccess?.()); return op; };
    const db = { objectStoreNames: { contains: () => true }, transaction: () => ({ objectStore: () => ({
        get: key => request(map.get(key)), put: value => { map.set(value.key, value); return request(value.key); },
        getAll: () => request([...map.values()]), delete: key => { map.delete(key); return request(undefined); },
    }) }) };
    return { open() { const op = { result: db }; queueMicrotask(() => op.onsuccess?.()); return op; }, map };
}
function harness() {
    const settings = { apiPresets: [], activeApiPresetId: 'tavern', phoneModel: '', voiceCacheMB: 10, voiceProvider: 'minimax',
        ttsMiniMax: { baseUrl: 'https://api.minimaxi.com', apiKey: '', groupId: '', model: 'speech-2.8-hd' },
        ttsElevenLabs: { baseUrl: 'https://api.elevenlabs.io', apiKey: '', model: 'eleven_v4' } };
    const context = { extensionSettings: {}, generateRaw: async () => '酒馆回复' };
    const contacts = [{ name: '阿澜', source: { type: 'world', book: '副书', uid: 7 }, level: 'normal', voice: { provider: 'minimax', voiceId: 'test-voice' } }];
    let calls = [], cache = memoryDB();
    const scope = vm.createContext({ URL, Blob, Uint8Array, TextEncoder, crypto: webcrypto, indexedDB: cache,
        ctx: () => context, getSettings: () => settings, setSetting: (key, value) => { settings[key] = value; },
        selectedContacts: () => contacts,
        fetch: async (url, options) => {
            calls.push({ url: String(url), options });
            if (String(url).includes('/chat/completions')) return { ok: true, json: async () => ({ choices: [{ message: { content: '预设回复' } }] }) };
            if (String(url).includes('/v2/voices')) return { ok: true, json: async () => ({ voices: [{ voice_id: 'v1', name: '温柔' }], has_more: false }) };
            if (String(url).includes('/text-to-speech/')) return { ok: true, blob: async () => bytes };
            return { ok: true, json: async () => ({ base_resp: { status_code: 0 }, data: { audio: '010203' } }) };
        } });
    vm.runInContext(source('api') + '\n' + source('voice'), scope);
    return { scope, settings, context, contacts, calls: () => calls, cache };
}

test('API preset switches Bluebird requests without changing Tavern connection; /v1 base works', async () => {
    const h = harness(), request = { systemPrompt: '系统', prompt: '你好', responseLength: 100 };
    assert.equal(await h.scope.requestBluebirdRaw(h.context, request, h.settings), '酒馆回复');
    h.scope.saveApiPresets([{ id: 'one', name: 'Flash', baseUrl: 'https://api.example/v1', apiKey: 'secret', model: 'flash' }], 'one');
    assert.equal(await h.scope.requestBluebirdRaw(h.context, request, h.settings), '预设回复');
    assert.equal(h.calls()[0].url, 'https://api.example/v1/chat/completions');
    const body = JSON.parse(h.calls()[0].options.body);
    assert.equal(body.model, 'flash'); assert.equal(body.messages[1].content, '你好');
    assert.equal(h.context.generateRaw instanceof Function, true);
});

test('Playhouse key takes precedence and missing key leaves voice as text', async () => {
    const h = harness(), message = { id: 'm1', sender: '阿澜', content: '你好', note: '', type: 'voice' };
    assert.equal(h.scope.voiceAvailability(message, h.context).ready, false);
    assert.equal(await h.scope.synthesizeVoice(message, h.context, h.settings), null);
    h.settings.ttsMiniMax.apiKey = 'bluebird-key';
    h.context.extensionSettings.playhouse = { tts: { apiKey: 'playhouse-key', baseUrl: 'https://api.minimaxi.com', model: 'speech-2.8-hd' }, voiceBank: [{ voiceId: 'test-voice', label: '梨园音色' }] };
    assert.equal(h.scope.voiceSource('minimax', h.context, h.settings).source, '梨园');
    assert.equal(h.scope.knownVoices('minimax', h.context)[0].label, '梨园音色');
    const blob = await h.scope.synthesizeVoice(message, h.context, h.settings);
    assert.equal(blob.size, 3); assert.equal(h.calls()[0].options.headers.Authorization, 'Bearer playhouse-key');
    assert.equal(JSON.parse(h.calls()[0].options.body).voice_setting.voice_id, 'test-voice');
    await h.scope.synthesizeVoice(message, h.context, h.settings);
    assert.equal(h.calls().length, 1); assert.equal(h.cache.map.size, 1);
    assert.equal(JSON.stringify([...h.cache.map.values()]).includes('playhouse-key'), false);
});

test('ElevenLabs uses account voice list and audio response, MiniMax emotion is optional', async () => {
    const h = harness(); h.contacts[0].voice = { provider: 'elevenlabs', voiceId: 'v1' };
    h.settings.voiceProvider = 'elevenlabs';
    h.settings.ttsElevenLabs.apiKey = 'eleven-key';
    const voices = await h.scope.loadVoiceCatalog('elevenlabs', h.context);
    assert.equal(voices[0].voiceId, 'v1');
    const message = { id: 'e', sender: '阿澜', type: 'voice', content: '你好', note: '' };
    const blob = await h.scope.synthesizeVoice(message, h.context, h.settings);
    assert.equal(blob.size, 3);
    assert.match(h.calls()[1].url, /\/v1\/text-to-speech\/v1\?output_format=/);
    assert.equal(h.calls()[1].options.headers['xi-api-key'], 'eleven-key');
    const mini = h.scope.synthesisRequest({ content: '你好', note: 'happy' }, { provider: 'minimax', voiceId: 'voice' }, h.settings.ttsMiniMax);
    assert.equal(mini.body.voice_setting.emotion, 'happy');
});

test('generated voice tone directs compatible TTS without changing the visible transcript', () => {
    const h = harness(), config = { provider: 'elevenlabs', voiceId: 'v1' };
    const utterance = { content: '你回来啦。', note: 'whisper' };
    const eleven = h.scope.synthesisRequest(utterance, config, h.settings.ttsElevenLabs);
    assert.equal(eleven.body.text, '[whispers] 你回来啦。');
    assert.equal(utterance.content, '你回来啦。');
    assert.equal(h.scope.synthesisRequest({ ...utterance, note: 'calm' }, config, h.settings.ttsElevenLabs).body.text, utterance.content);
    assert.equal(h.scope.synthesisRequest({ ...utterance, note: '[laughs] fake' }, config, h.settings.ttsElevenLabs).body.text, utterance.content);
    assert.equal(h.scope.synthesisRequest(utterance, config, { ...h.settings.ttsElevenLabs, model: 'eleven_multilingual_v2' }).body.text, utterance.content);
    const mini = { provider: 'minimax', voiceId: 'voice' };
    assert.equal(h.scope.synthesisRequest(utterance, mini, h.settings.ttsMiniMax).body.voice_setting.emotion, undefined);
    assert.equal(h.scope.synthesisRequest(utterance, mini, { ...h.settings.ttsMiniMax, model: 'speech-2.6-hd' }).body.voice_setting.emotion, 'whisper');
});

test('global provider uses each contact’s matching voice and reads both Playhouse voice banks', () => {
    const h = harness(), message = { sender: '阿澜', type: 'voice', content: '你好' };
    h.contacts[0].voice = { minimax: 'mini-a', elevenlabs: 'eleven-a' };
    h.context.extensionSettings.playhouse = { voiceBank: [{ voiceId: 'mini-a', label: '小米' }],
        elevenLabsVoices: { voiceBank: [{ voiceId: 'eleven-a', label: '小十一' }] },
        tts: { apiKey: 'mini-key', elevenlabs: { apiKey: 'eleven-key' } } };
    assert.equal(h.scope.knownVoices('minimax', h.context)[0].label, '小米');
    assert.equal(h.scope.knownVoices('elevenlabs', h.context)[0].label, '小十一');
    assert.equal(h.scope.voiceAvailability(message, h.context).config.voiceId, 'mini-a');
    h.settings.voiceProvider = 'elevenlabs';
    assert.equal(h.scope.voiceAvailability(message, h.context).config.voiceId, 'eleven-a');
    h.contacts[0].voice = { minimax: 'mini-a' };
    assert.equal(h.scope.voiceAvailability(message, h.context).ready, false);
});

test('playback unlocks during the click and stops the previous clip', async () => {
    const h = harness(), actions = [];
    class FakeAudioContext {
        constructor() { this.sampleRate = 44100; this.destination = {}; }
        resume() { actions.push('resume'); return Promise.resolve(); }
        createBuffer() { return {}; }
        createBufferSource() {
            return { connect() {}, disconnect() {}, start() { actions.push('start'); }, stop() { actions.push('stop'); } };
        }
        async decodeAudioData() { return {}; }
    }
    h.scope.AudioContext = FakeAudioContext;
    h.settings.ttsMiniMax.apiKey = 'key';
    const first = { id: 'one', sender: '阿澜', type: 'voice', content: '你好' };
    const promise = h.scope.playVoice(first);
    assert.deepEqual(actions.slice(0, 2), ['resume', 'start']);
    await promise; assert.equal(h.scope.playingVoiceId(), 'one');
    await h.scope.playVoice({ ...first, id: 'two' });
    assert.equal(h.scope.playingVoiceId(), 'two'); assert.ok(actions.includes('stop'));
    h.scope.stopVoice(); assert.equal(h.scope.playingVoiceId(), '');
});
