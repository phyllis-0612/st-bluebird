import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { icons } from '../src/icons.js';
import { buildState, hidePhoneTags, fingerprint, detectChatTags } from '../src/messages.js';
import { makeDOM } from './dom-helper.mjs';

const source = name => fs.readFileSync(new URL(`../src/${name}.js`, import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/export /g, '');
const fixture = `<bb-phone>陆|text|你好\n陆|voice|听我说\n陆|image|雨里的车窗\n陆|transfer|200|打车钱\n陆|location|便利店|等雨</bb-phone>
<bb-phone source="phone" chat="陆">我|text|我到了</bb-phone><bb-present>陆</bb-present>`;
const makeState = () => buildState([{ mes: fixture, extra: { bluebird: { floorId: 'f' } } }]);

function panelHarness() {
    const { document, Element } = makeDOM();
    const root = document.createElement('div'); root.id = 'bluebird-panel'; document.body.append(root);
    const phone = document.createElement('section'); phone.className = 'bb-phone'; root.append(phone);
    const close = document.createElement('button'); close.dataset.bbAction = 'close'; phone.append(close);
    const story = document.createElement('p'); story.className = 'bb-story'; phone.append(story);
    const body = document.createElement('main'); body.className = 'bb-body'; phone.append(body);
    for (const page of ['list', 'contacts', 'settings']) { const b = document.createElement('button'); b.className = 'bb-tab'; b.dataset.bbPage = page; phone.append(b); }
    let state = makeState(), readCalls = 0;
    const sent = [], replies = [], status = { phase: 'idle' };
    let contacts = [{ name: '剧情', source: { type: 'card' }, level: 'normal', voice: {} }, { name: '陆', source: { type: 'card' }, level: 'normal', voice: {} }];
    const settings = { enabled: true, inlineNotice: true, voiceEnabled: true, voiceProvider: 'minimax', theme: 'auto', entryMode: 'floating', thinkTags: ['think'], statusTags: ['status'], apiPresets: [], activeApiPresetId: 'tavern', ttsMiniMax: { baseUrl: 'https://api.minimaxi.com', apiKey: '', groupId: '', model: 'speech-2.8-hd' }, ttsElevenLabs: { baseUrl: 'https://api.elevenlabs.io', apiKey: '', model: 'eleven_v4' }, voiceCacheMB: 200, proactiveEnabled: true, proactiveLevel: 'normal', proactiveCooldown: 3, proactiveDepth: 0 };
    const scope = vm.createContext({ document, HTMLElement: Element, MutationObserver: class { observe() {} disconnect() {} },
        rootNode: root, icons, fingerprint, detectChatTags, normalizeTagName: value => String(value).replace(/[<>]/g, '').trim(),
        parseTagNames: value => [...new Set(String(value).split(/[,，\s]+/).map(t => t.replace(/[<>]/g, '').trim()).filter(Boolean))],
        activeApiPreset: () => settings.apiPresets.find(p => p.id === settings.activeApiPresetId), saveApiPresets: (list, id) => { settings.apiPresets = list; settings.activeApiPresetId = id; }, listApiModels: async () => ['flash'], knownVoices: provider => provider === 'minimax' ? [{ voiceId: 'm-1', label: '梨园小米' }] : [{ voiceId: 'e-1', label: '梨园小十一' }], voiceSource: () => ({ source: '梨园' }), voiceAvailability: () => ({ ready: false }), playingVoiceId: () => '', playVoice: async () => false, stopVoice() {}, getStoryContacts: () => ['剧情', '陆'], selectedContacts: () => contacts, saveContacts: list => { contacts = list; }, extractContacts: async () => [], VERSION: '0.6.3', getSettings: () => settings, setSetting: (key, value) => { settings[key] = value; },
        ctx: () => ({ characters: [{ name: '剧情' }], characterId: 0, chat: [{ mes: '<灵魂疏理>隐秘</灵魂疏理><状态栏>体力 80</状态栏><content>正文</content>' }] }), applyThemeEverywhere() {},
        getChatState: () => state, rebuildChatState() {},
        markConversationRead(id) { const c = state.conversations.find(c => c.id === id); if (c?.unread) { readCalls++; state.unread -= c.unread; c.unread = 0; } },
        scrollToFloor() {}, processTransfer() {}, getPhoneStatus: () => status, isGenerationBusy: () => false,
        captureCurrentChat: () => ({}), currentChatMatches: () => true, sendPhoneMessage: async (...args) => { sent.push(args); }, requestPhoneReply: name => { replies.push(name); }, toastr: { info() {}, error() {} } });
    vm.runInContext(source('entry-controls') + '\n' + source('panel') + '\nroot = rootNode;', scope);
    return { document, root, scope, settings, sent, replies, status, contacts: () => contacts, reads: () => readCalls, state: () => state,
        setState(s) { state = s; }, click: async button => scope.onClick({ target: button }) };
}

test('list and conversation show all five cards, outgoing bubble, enabled composer and floor link', async () => {
    const h = panelHarness(); h.scope.openPanel();
    assert.equal(h.root.querySelector('.bb-unread-pill').textContent, '5');
    await h.click(h.root.querySelector('[data-bb-conversation]'));
    assert.equal(h.root.querySelectorAll('.bb-message').length, 6);
    assert.equal(h.root.querySelectorAll('.bb-card').length, 4);
    assert.equal(h.root.querySelectorAll('.is-self').length, 1);
    assert.equal(h.root.querySelector('.bb-compose-input').disabled, false);
    assert.equal(h.root.querySelectorAll('[data-bb-transfer]').length, 2);
    assert.equal(h.root.querySelector('[data-bb-floor-message]').textContent, '第 1 楼 ↗');
    assert.equal(h.root.querySelector('.bb-presence').textContent, '最近记录：与你同场');
    assert.equal(h.reads(), 1); assert.equal(h.state().unread, 0);
    await h.click(h.root.querySelector('[data-bb-action="back"]'));
    assert.equal(h.root.querySelector('.bb-unread-pill'), null);
});

test('incoming text and sender names use textContent; no user text becomes HTML', () => {
    const h = panelHarness();
    const malicious = '<img src=x onerror=alert(1)>';
    h.setState(buildState([{ mes: `<bb-phone>${malicious}|text|${malicious}</bb-phone>`, extra: { bluebird: { floorId: 'x' } } }]));
    h.scope.openConversation('name:' + malicious);
    assert.equal(h.root.querySelector('.bb-bubble').textContent, malicious);
    assert.equal(h.root.querySelector('.bb-bubble').innerHTML, '');
    assert.equal(h.root.querySelector('.bb-chat-name').textContent, malicious);
});

test('chat switch resets the conversation and settings toggle is enabled', () => {
    const h = panelHarness(); h.scope.openConversation('name:陆');
    h.setState(buildState([])); h.scope.refreshPanel('chat');
    assert.equal(h.root.querySelector('.bb-empty-title').textContent, '还没有消息');
    vm.runInContext("page = 'settings'; render();", h.scope);
    assert.equal(h.root.querySelector('[data-bb-setting="inlineNotice"]').disabled, false);
    h.settings.enabled = false; h.scope.refreshPanel(); assert.equal(h.root.hidden, true);
});

function integrationHarness() {
    const { document, Element } = makeDOM();
    const chat = document.createElement('div'); chat.id = 'chat'; document.body.append(chat);
    const floor = document.createElement('div'); floor.className = 'mes'; floor.setAttribute('mesid', '0'); chat.append(floor);
    const text = document.createElement('div'); text.className = 'mes_text'; floor.append(text);
    const state = makeState(), events = new Map(), hooks = [], frames = [], settingListeners = [], observers = [], generationSignals = [];
    const settings = { enabled: true, inlineNotice: true };
    let settingsSaves = 0, opened = null, rebuilds = 0;
    const data = { extensionSettings: { regex: [{ id: 'user', scriptName: '青鸟之外的用户脚本', findRegex: 'keep' }] },
        chat: [state.conversations[0].messages[0].floorRef], updateMessageBlock() {},
        saveSettingsDebounced() { settingsSaves++; },
        messageFormatter: { addHook(fn, opts) { hooks.push({ fn, opts }); } },
        eventTypes: Object.fromEntries(['CHAT_CHANGED', 'MESSAGE_SWIPED', 'GENERATION_STARTED', 'GENERATION_ENDED', 'USER_MESSAGE_RENDERED', 'APP_READY'].map(n => [n, n])),
        eventSource: { on(name, fn) { events.set(name, fn); } } };
    const scope = vm.createContext({ document, HTMLElement: Element, ctx: () => data, hidePhoneTags,
        getSettings: () => settings, getChatState: () => state, rebuildChatState() { rebuilds++; }, setGenerationActive: value => generationSignals.push(value),
        onChatStateChanged() {}, onSettingChanged: fn => settingListeners.push(fn),
        requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, setTimeout: fn => { frames.push(fn); return frames.length; },
        MutationObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() {} },
        captureCurrentChat: () => ({}), currentChatMatches: () => true,
        window: { matchMedia: () => ({ matches: true }) } });
    vm.runInContext(source('chat-integration'), scope);
    const install = () => scope.initChatIntegration(id => { opened = id; });
    return { document, floor, text, state, data, scope, settings, settingListeners, events, hooks, frames, observers,
        install, generationSignals, stats: () => ({ settingsSaves, opened, rebuilds }) };
}

test('global regex installation is idempotent, preserves user scripts, and uses display/prompt flags', () => {
    const h = integrationHarness(); h.install(); h.install(); h.scope.syncRegexRules();
    assert.equal(h.data.extensionSettings.regex.length, 4); assert.equal(h.hooks.length, 1);
    assert.equal(h.data.extensionSettings.regex[0].findRegex, 'keep');
    const rules = h.data.extensionSettings.regex.slice(1);
    assert.equal(rules.filter(r => r.markdownOnly).length, 2);
    assert.equal(rules.filter(r => r.promptOnly).length, 1);
    const apply = (text, isPrompt) => rules.filter(r => isPrompt ? r.promptOnly : r.markdownOnly).reduce((s, r) => {
        const m = r.findRegex.match(/^\/(.*)\/([a-z]*)$/); return s.replace(new RegExp(m[1], m[2]), r.replaceString);
    }, text);
    assert.equal(apply('正文' + fixture, false), '正文\n');
    assert.match(apply(fixture, true), /<bb-phone>/);
    assert.doesNotMatch(apply(fixture, true), /bb-present/);
    assert.equal(h.hooks[0].fn('正文' + fixture), '正文\n');
    h.settings.enabled = false; h.scope.syncRegexRules();
    assert.equal(rules.every(r => r.disabled), true);
    assert.equal(h.hooks[0].fn(fixture), fixture);
});

test('notice counts incoming only, opens the conversation, avoids duplicates and obeys the switch', () => {
    const h = integrationHarness(); h.install(); h.scope.refreshFloorNotices();
    const button = h.text.querySelector('.bb-inline-notice');
    assert.equal(button.textContent, '陆发来 5 条消息'); button.click();
    assert.equal(h.stats().opened, 'name:陆');
    h.scope.refreshFloorNotices(); assert.equal(h.text.querySelectorAll('.bb-inline-notice').length, 1);
    h.settings.inlineNotice = false; h.scope.refreshFloorNotices(); assert.equal(h.text.children.length, 0);
    h.settings.inlineNotice = true; h.scope.refreshFloorNotices(); assert.equal(h.text.querySelectorAll('.bb-inline-notice').length, 1);
    h.floor.replaceChildren(); h.scope.refreshFloorNotices();
});

test('DOM observer ignores its own notices but responds to streamed text and swipe events', () => {
    const h = integrationHarness(); h.install();
    h.scope.refreshFloorNotices(); const notice = h.text.querySelector('.bb-floor-notices');
    const before = h.frames.length;
    h.observers[0].fn([{ type: 'childList', target: h.text, addedNodes: [notice], removedNodes: [] }]);
    assert.equal(h.frames.length, before);
    h.observers[0].fn([{ type: 'characterData', target: { nodeType: 3 }, addedNodes: [], removedNodes: [] }]);
    assert.equal(h.frames.length, before + 1);
    h.events.get('MESSAGE_SWIPED')();
    for (const fn of h.frames.splice(0)) fn();
    assert.ok(h.stats().rebuilds >= 2);
});

test('floor jump uses the current floor object and refuses deleted source floors', async () => {
    const h = integrationHarness(); h.install(); const message = h.state.conversations[0].messages[0];
    await h.scope.scrollToFloor(message); assert.equal(h.floor.scrolled.block, 'center');
    h.data.chat.length = 0;
    await assert.rejects(h.scope.scrollToFloor(message), /已经删除/);
});

test('voice transcript is collapsed, expands on click and survives a normal refresh', async () => {
    const h = panelHarness(); h.scope.openPanel();
    assert.equal(h.scope.messagePreview({ type: 'voice', content: '秘密内容' }), '[语音消息]');
    h.scope.openConversation('name:陆');
    const play = h.root.querySelector('[data-bb-voice]');
    assert.equal(play.getAttribute('aria-expanded'), 'false');
    assert.equal(h.root.querySelector('.bb-voice-transcript').hidden, true);
    await h.click(play);
    assert.equal(h.root.querySelector('.bb-voice-transcript').hidden, false);
    assert.equal(play.getAttribute('aria-expanded'), 'true');
    assert.equal(h.root.querySelector('.bb-voice-transcript .bb-card-text').textContent, '听我说');
    h.scope.refreshPanel();
    assert.equal(h.root.querySelector('.bb-voice-transcript').hidden, false);
});

test('voice mode off uses a text bubble; re-enabling or changing chat resets expansion', async () => {
    const h = panelHarness(); h.scope.openConversation('name:陆');
    await h.click(h.root.querySelector('[data-bb-voice]'));
    h.settings.voiceEnabled = false; h.scope.refreshPanel('voice-mode');
    assert.equal(h.root.querySelector('[data-bb-voice]'), null);
    assert.equal(h.root.querySelector('.bb-voice-text').textContent, '听我说');
    assert.equal(h.scope.messagePreview({ type: 'voice', content: '秘密内容' }), '秘密内容');
    h.settings.voiceEnabled = true; h.scope.refreshPanel('voice-mode');
    assert.equal(h.root.querySelector('.bb-voice-transcript').hidden, true);
    await h.click(h.root.querySelector('[data-bb-voice]'));
    h.scope.refreshPanel('chat'); h.scope.openConversation('name:陆');
    assert.equal(h.root.querySelector('.bb-voice-transcript').hidden, true);
});

test('prompt dry runs and quiet background calls cannot latch the generation lock', () => {
    const h = integrationHarness(); h.install();
    const started = h.events.get('GENERATION_STARTED');
    started('normal', {}, true); started('quiet', {}, false);
    assert.deepEqual(h.generationSignals, []);
    started('normal', {}, false);
    started('normal', {}, true); // 预演也不能解除正在进行的真实生成。
    assert.deepEqual(h.generationSignals, [true]);
    h.events.get('GENERATION_ENDED')();
    assert.deepEqual(h.generationSignals, [true, false]);
    started('quiet', { quietToLoud: true }, false);
    assert.deepEqual(h.generationSignals, [true, false, true]);
});

test('proactive settings persist button choices and numeric values, reject invalid cooldown, and show current contacts', async () => {
    const h = panelHarness(); h.scope.openPanel();
    await h.click(h.root.querySelector('[data-bb-page="settings"]'));
    const toggle = h.root.querySelector('[data-bb-setting="proactiveEnabled"]');
    assert.equal(toggle.checked, true); toggle.checked = false; h.scope.onChange({ target: toggle });
    assert.equal(h.settings.proactiveEnabled, false);
    const choices = h.root.querySelectorAll('[data-bb-setting="proactiveLevel"]'); assert.equal(choices.length, 3);
    h.scope.onChange({ target: choices.find(n => n.value === 'clingy') }); assert.equal(h.settings.proactiveLevel, 'clingy');
    const depth = h.root.querySelectorAll('[data-bb-setting="proactiveDepth"]');
    h.scope.onChange({ target: depth.find(n => n.value === '1') }); assert.equal(h.settings.proactiveDepth, 1);
    const cooldown = h.root.querySelector('[data-bb-setting="proactiveCooldown"]');
    cooldown.value = '0'; h.scope.onChange({ target: cooldown }); assert.equal(h.settings.proactiveCooldown, 0);
    for (const value of ['', '-1', '1.5', '9007199254740992']) {
        cooldown.value = value; h.scope.onChange({ target: cooldown }); assert.equal(h.settings.proactiveCooldown, 0); assert.equal(cooldown.value, '0');
    }
    await h.click(h.root.querySelector('[data-bb-page="contacts"]'));
    assert.equal(h.root.querySelector('.bb-contact-open').textContent, '剧情');
    await h.click(h.root.querySelector('[data-bb-page="settings"]'));
    assert.equal(h.root.querySelector('[data-bb-setting="proactiveEnabled"]').checked, false);
    assert.equal(h.root.querySelectorAll('[data-bb-setting="proactiveLevel"]').find(n => n.value === 'clingy').checked, true);
});

test('settings switch the TTS service while contacts keep one Playhouse voice per provider', async () => {
    const h = panelHarness(); h.scope.openPanel();
    await h.click(h.root.querySelector('[data-bb-page="contacts"]'));
    let pick = h.root.querySelector('[data-bb-voice-select="陆"]');
    assert.ok(pick.children.some(option => option.textContent === '梨园小米'));
    pick.value = 'm-1'; h.scope.onChange({ target: pick });
    assert.equal(h.contacts().find(c => c.name === '陆').voice.minimax, 'm-1');
    assert.equal(h.root.querySelector('[data-bb-voice-select="陆"]'), pick, '选择音色时保留原下拉框，不打断滚动');
    assert.equal(h.root.querySelector('[data-bb-voice-id="陆"]').value, 'm-1');
    await h.click(h.root.querySelector('[data-bb-page="settings"]'));
    const eleven = h.root.querySelectorAll('[data-bb-setting="voiceProvider"]').find(input => input.value === 'elevenlabs');
    h.scope.onChange({ target: eleven }); assert.equal(h.settings.voiceProvider, 'elevenlabs');
    await h.click(h.root.querySelector('[data-bb-page="contacts"]'));
    pick = h.root.querySelector('[data-bb-voice-select="陆"]');
    assert.ok(pick.children.some(option => option.textContent === '梨园小十一'));
    pick.value = 'e-1'; h.scope.onChange({ target: pick });
    assert.equal(h.contacts().find(c => c.name === '陆').voice.elevenlabs, 'e-1');
    assert.equal(h.contacts().find(c => c.name === '陆').voice.minimax, 'm-1');
});

test('refreshing contact voices rereads the latest Playhouse list', async () => {
    const h = panelHarness(); h.scope.openPanel(); await h.click(h.root.querySelector('[data-bb-page="contacts"]'));
    assert.equal(h.root.querySelector('[data-bb-voice-select="陆"]').children.some(option => option.value === 'm-2'), false);
    h.scope.knownVoices = () => [{ voiceId: 'm-1', label: '梨园小米' }, { voiceId: 'm-2', label: '梨园新音色' }];
    await h.click(h.root.querySelector('[data-bb-action="refresh-playhouse-voices"]'));
    assert.ok(h.root.querySelector('[data-bb-voice-select="陆"]').children.some(option => option.value === 'm-2'));
});

test('Chinese thought tag persists and detected status tag can be checked and unchecked', async () => {
    const h = panelHarness(); h.scope.openPanel(); await h.click(h.root.querySelector('[data-bb-page="settings"]'));
    const thought = h.root.querySelector('[data-bb-setting="thinkTags"]'); thought.value = 'think, <灵魂疏理>';
    h.scope.onChange({ target: thought }); assert.deepEqual(h.settings.thinkTags, ['think', '灵魂疏理']);
    let status = h.root.querySelector('[data-bb-status-tag="状态栏"]');
    assert.ok(status); assert.equal(status.checked, false);
    status.checked = true; h.scope.onChange({ target: status });
    assert.ok(h.settings.statusTags.includes('状态栏'));
    assert.match(h.root.querySelector('[data-bb-setting="statusTags"]').value, /状态栏/);
    await h.click(h.root.querySelector('[data-bb-page="contacts"]'));
    await h.click(h.root.querySelector('[data-bb-page="settings"]'));
    assert.match(h.root.querySelector('[data-bb-setting="thinkTags"]').value, /灵魂疏理/);
    status = h.root.querySelector('[data-bb-status-tag="状态栏"]'); assert.equal(status.checked, true);
    status.checked = false; h.scope.onChange({ target: status }); assert.equal(h.settings.statusTags.includes('状态栏'), false);
});

test('API presets can be created, filled, selected and deleted without changing Tavern settings', async () => {
    const h = panelHarness(); h.scope.openPanel(); await h.click(h.root.querySelector('[data-bb-page="settings"]'));
    await h.click(h.root.querySelector('[data-bb-action="api-new"]'));
    assert.equal(h.settings.apiPresets.length, 1);
    const name = h.root.querySelector('[data-bb-api-field="name"]'); name.value = 'Flash'; h.scope.onChange({ target: name });
    const url = h.root.querySelector('[data-bb-api-field="baseUrl"]'); url.value = 'https://api.example/v1'; h.scope.onChange({ target: url });
    assert.equal(h.settings.apiPresets[0].name, 'Flash'); assert.equal(h.settings.apiPresets[0].baseUrl, 'https://api.example/v1');
    await h.click(h.root.querySelector('[data-bb-action="api-copy"]')); assert.equal(h.settings.apiPresets.length, 2);
    await h.click(h.root.querySelector('[data-bb-action="api-delete"]')); assert.equal(h.settings.apiPresets.length, 1);
    assert.equal(h.settings.activeApiPresetId, 'tavern');
});

test('phone composer preserves drafts on refresh, sends text and transfer, clears only successfully sent fields', async () => {
    const h = panelHarness(); h.scope.openConversation('name:陆');
    const text = h.root.querySelector('.bb-compose-input'); text.value = '正在写的消息'; h.scope.onInput({ target: text });
    h.scope.refreshPanel(); assert.equal(h.root.querySelector('.bb-compose-input').value, '正在写的消息');
    await h.click(h.root.querySelector('[data-bb-action="send-text"]'));
    assert.deepEqual(h.sent[0], ['陆', 'text', '正在写的消息', '']); assert.equal(h.root.querySelector('.bb-compose-input').value, '');
    await h.click(h.root.querySelector('[data-bb-action="attachments"]')); assert.equal(h.root.querySelectorAll('[data-bb-attachment]').length, 4);
    await h.click(h.root.querySelector('[data-bb-attachment="transfer"]'));
    for (const [key, value] of [['content', '12.50'], ['note', '车费']]) { const input = h.root.querySelector(`[data-bb-draft="${key}"]`); input.value = value; h.scope.onInput({ target: input }); }
    await h.click(h.root.querySelector('[data-bb-action="send-attachment"]'));
    assert.deepEqual(h.sent[1], ['陆', 'transfer', '12.50', '车费']); assert.equal(h.root.querySelector('.bb-attachment-form'), null);
});

test('reply status and retry affordance survive reload with pending user messages', () => {
    const h = panelHarness(), state = makeState();
    state.conversations[0].messages.push({ sender: '我', type: 'text', content: '暂存问题', id: 'pending:test', isSelf: true, pending: true, floorIndex: null });
    h.setState(state); h.scope.openConversation('name:陆');
    assert.match(h.root.querySelector('.bb-phone-status').textContent, /已发 1 条/); assert.equal(h.root.querySelector('[data-bb-action="request-reply"]').textContent, '让对方回复');
    h.status.phase = 'typing'; h.scope.refreshPanel(); assert.match(h.root.querySelector('.bb-phone-status').textContent, /正在输入/);
});


test('three queued phone messages show one manual reply control, which triggers a single request', async () => {
    const h = panelHarness(), state = makeState();
    for (const n of [1, 2, 3]) state.conversations[0].messages.push({ sender: '我', type: 'text', content: `问题${n}`, id: `pending:${n}`, isSelf: true, pending: true, floorIndex: null });
    h.setState(state); h.scope.openConversation('name:陆');
    assert.match(h.root.querySelector('.bb-phone-status').textContent, /已发 3 条/);
    assert.equal(h.replies.length, 0);
    await h.click(h.root.querySelector('[data-bb-action="request-reply"]'));
    assert.deepEqual(h.replies, ['陆']);
});
