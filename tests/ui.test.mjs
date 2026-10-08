import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { icons } from '../src/icons.js';
import { buildState, hidePhoneTags } from '../src/messages.js';
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
    const settings = { enabled: true, inlineNotice: true, theme: 'auto', entryMode: 'floating', thinkTags: ['think'] };
    const scope = vm.createContext({ document, HTMLElement: Element, MutationObserver: class { observe() {} disconnect() {} },
        rootNode: root, icons, VERSION: '0.2.0', getSettings: () => settings, setSetting: (key, value) => { settings[key] = value; },
        ctx: () => ({ characters: [{ name: '剧情' }], characterId: 0 }), applyThemeEverywhere() {},
        getChatState: () => state, rebuildChatState() {},
        markConversationRead(id) { const c = state.conversations.find(c => c.id === id); if (c?.unread) { readCalls++; state.unread -= c.unread; c.unread = 0; } },
        scrollToFloor() {}, processTransfer() {}, toastr: { info() {}, error() {} } });
    vm.runInContext(source('entry-controls') + '\n' + source('panel') + '\nroot = rootNode;', scope);
    return { document, root, scope, settings, reads: () => readCalls, state: () => state,
        setState(s) { state = s; }, click: async button => scope.onClick({ target: button }) };
}

test('list and conversation show all five cards, outgoing bubble, disabled composer and floor link', async () => {
    const h = panelHarness(); h.scope.openPanel();
    assert.equal(h.root.querySelector('.bb-unread-pill').textContent, '5');
    await h.click(h.root.querySelector('[data-bb-conversation]'));
    assert.equal(h.root.querySelectorAll('.bb-message').length, 6);
    assert.equal(h.root.querySelectorAll('.bb-card').length, 4);
    assert.equal(h.root.querySelectorAll('.is-self').length, 1);
    assert.equal(h.root.querySelector('.bb-compose-input').disabled, true);
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
    const state = makeState(), events = new Map(), hooks = [], frames = [], settingListeners = [], observers = [];
    const settings = { enabled: true, inlineNotice: true };
    let settingsSaves = 0, opened = null, rebuilds = 0;
    const data = { extensionSettings: { regex: [{ id: 'user', scriptName: '青鸟之外的用户脚本', findRegex: 'keep' }] },
        chat: [state.conversations[0].messages[0].floorRef], updateMessageBlock() {},
        saveSettingsDebounced() { settingsSaves++; },
        messageFormatter: { addHook(fn, opts) { hooks.push({ fn, opts }); } },
        eventTypes: Object.fromEntries(['CHAT_CHANGED', 'MESSAGE_SWIPED', 'GENERATION_STARTED', 'GENERATION_ENDED', 'USER_MESSAGE_RENDERED', 'APP_READY'].map(n => [n, n])),
        eventSource: { on(name, fn) { events.set(name, fn); } } };
    const scope = vm.createContext({ document, HTMLElement: Element, ctx: () => data, hidePhoneTags,
        getSettings: () => settings, getChatState: () => state, rebuildChatState() { rebuilds++; }, setGenerationActive() {},
        onChatStateChanged() {}, onSettingChanged: fn => settingListeners.push(fn),
        requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, setTimeout: fn => { frames.push(fn); return frames.length; },
        MutationObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() {} },
        captureCurrentChat: () => ({}), currentChatMatches: () => true,
        window: { matchMedia: () => ({ matches: true }) } });
    vm.runInContext(source('chat-integration'), scope);
    const install = () => scope.initChatIntegration(id => { opened = id; });
    return { document, floor, text, state, data, scope, settings, settingListeners, events, hooks, frames, observers,
        install, stats: () => ({ settingsSaves, opened, rebuilds }) };
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
