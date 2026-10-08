import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseFloor, serializeFields, storyContacts } from '../src/messages.js';
const source = n => fs.readFileSync(new URL(`../src/${n}.js`, import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/export /g, '');
const phone = '<bb-phone>陆|text|到家了吗</bb-phone>';
const floor = mes => ({ mes, is_user: false });
function harness() {
    const events = new Map(), calls = [];
    const c = { chat: [], chatMetadata: {}, characterId: 0, groupId: null, chatId: 'first', name1: '鱼仔',
        characters: [{ avatar: 'lu.png', name: '陆' }, { avatar: 'he.png', name: '何' }], groups: [], extensionSettings: {}, saveSettingsDebounced() {},
        eventTypes: Object.fromEntries(['GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED'].map(n => [n, n])),
        eventSource: { on(n, fn) { events.set(n, fn); } }, setExtensionPrompt(...args) { calls.push(args); } };
    const scope = vm.createContext({ world_info: {}, SillyTavern: { getContext: () => c }, window: { matchMedia: () => ({ matches: false }) },
        document: { querySelectorAll: () => [] }, parseFloor, serializeFields, storyContacts, preparePendingGeneration() {},
        captureCurrentChat: () => ({ chat: c.chat, id: c.chatId }), currentChatMatches: o => o.chat === c.chat && o.id === c.chatId });
    vm.runInContext(source('settings') + '\n' + source('contacts') + '\n' + source('proactive'), scope);
    const settings = scope.getSettings();
    return { c, scope, settings, calls, events, prompt: type => scope.buildProactivePrompt(c, settings, type),
        prepare(type) { scope.prepareProactiveGeneration([], 8000, () => { throw Error('must not abort'); }, type); return calls.at(-1); } };
}
test('old settings migrate and malformed values reset; zero cooldown persists', () => {
    const h = harness(); assert.equal(h.settings.proactiveCooldown, 3); assert.equal(h.settings.proactiveEnabled, true);
    Object.assign(h.settings, { proactiveEnabled: 'false', proactiveLevel: 'invalid', proactiveCooldown: -1, proactiveDepth: '1' });
    h.scope.getSettings(); assert.equal(h.settings.proactiveEnabled, true); assert.equal(h.settings.proactiveCooldown, 3);
    assert.equal(h.settings.proactiveLevel, 'normal'); assert.equal(h.settings.proactiveDepth, 0);
    h.settings.proactiveCooldown = 0; h.scope.getSettings(); assert.equal(h.settings.proactiveCooldown, 0);
});
test('character zero is valid; groups use avatars and exclude disabled or missing cards', () => {
    const h = harness(); assert.deepEqual(Array.from(h.scope.getStoryContacts()), ['陆']);
    Object.assign(h.c, { groupId: '7', groups: [{ id: 7, members: ['he.png', 'missing.png', 'lu.png', 'he.png'], disabled_members: ['lu.png'] }] });
    assert.deepEqual(Array.from(h.scope.getStoryContacts()), ['何']);
    h.c.groupId = 'unknown'; assert.equal(h.prompt(), '');
    h.c.groupId = null; h.c.characterId = undefined; assert.equal(h.prompt(), '');
});
test('selected NPC and individual activity are included in the main story rule', () => {
    const h = harness();
    h.scope.saveContacts([{ name: '阿澜', source: { type: 'world', book: '副书', uid: 7 }, level: 'clingy' }], h.c);
    const prompt = h.prompt();
    assert.match(prompt, /"阿澜"（黏人/);
    assert.match(prompt, /"陆"（正常/);
    assert.deepEqual(Array.from(h.scope.getStoryContacts()), ['陆', '阿澜']);
});
test('rules use actual persona and escaped contact names; all five sample messages parse', () => {
    const h = harness(); h.c.characters[0].name = '陆|知行'; const p = h.prompt();
    assert.match(p, /鱼仔/); assert.doesNotMatch(p, /\{\{user\}\}/); assert.match(p, /同场的人不发/);
    const sample = parseFloor(p).messages; assert.equal(sample.length, 5); assert.ok(sample.every(m => m.sender === '陆|知行'));
    assert.equal(h.c.chat.length, 0);
});
test('cooldown counts intervening user and hidden floors at exact boundary', () => {
    const h = harness(); h.c.chat = [floor(phone), { mes: '一', is_user: true }, { mes: '二', is_system: true }];
    assert.equal(h.scope.cooldownState(h.c.chat, h.settings).remaining, 1); assert.match(h.prompt(), /冷却中/);
    assert.doesNotMatch(h.prompt(), /<bb-phone>/); h.c.chat.push(floor('三'));
    assert.equal(h.scope.cooldownState(h.c.chat, h.settings).remaining, 0); assert.match(h.prompt(), /<bb-phone>/);
    h.settings.proactiveCooldown = 0; h.c.chat = [floor(phone)]; assert.match(h.prompt(), /<bb-phone>/);
});
test('phone replies, user examples, thinking, code and malformed blocks do not reset cooldown', () => {
    const h = harness(); h.settings.thinkTags.push('thought');
    h.c.chat = [floor(phone), floor('<bb-phone source="phone" chat="陆">陆|text|回信</bb-phone>'), { mes: phone, is_user: true },
        floor('<thought>' + phone + '</thought>'), floor('```xml\n' + phone + '\n```'), floor('<bb-phone>陆|transfer|错误</bb-phone>')];
    assert.equal(h.scope.cooldownState(h.c.chat, h.settings).elapsed, 5); assert.match(h.prompt(), /<bb-phone>/);
});
test('edit, delete and changed mes recalculate without stale swipes', () => {
    const h = harness(); const f = floor(phone); f.swipes = [phone, '另一版']; h.c.chat = [f];
    assert.match(h.prompt(), /冷却中/); f.mes = '另一版'; assert.match(h.prompt(), /<bb-phone>/);
    f.mes = phone; h.c.chat = []; assert.match(h.prompt(), /<bb-phone>/);
});
test('swipe omits replaced reply, regenerate uses truncated history, continue avoids duplicate blocks', () => {
    const h = harness(); h.c.chat = [floor('序章'), floor(phone)];
    assert.match(h.prompt('swipe'), /<bb-phone>/); assert.match(h.prompt('normal'), /冷却中/);
    h.c.chat.pop(); assert.match(h.prompt('regenerate'), /<bb-phone>/);
    assert.match(h.prompt('continue'), /不要新增或重复/); assert.doesNotMatch(h.prompt('continue'), /<bb-phone>/);
});
test('switch retains presence and every proactive level forbids same-scene phone messages', () => {
    const h = harness(); h.settings.proactiveEnabled = false;
    assert.match(h.prompt(), /<bb-present>/); assert.match(h.prompt(), /已关闭/); assert.doesNotMatch(h.prompt(), /<bb-phone>/);
    h.settings.proactiveEnabled = true;
    for (const [value, label] of [['restrained', '克制'], ['normal', '正常'], ['clingy', '黏人']]) {
        h.settings.proactiveLevel = value; assert.match(h.prompt(), new RegExp(label)); assert.match(h.prompt(), /同场的人不发/);
    }
    h.settings.enabled = false; assert.equal(h.prompt(), '');
});
test('system injection uses chosen depth without worldbook scan; filter rejects switched chats', () => {
    const h = harness(); h.settings.proactiveDepth = 1; const a = h.prepare('normal');
    assert.equal(a[0], 'bluebird-phone'); assert.deepEqual(Array.from(a.slice(2, 6)), [1, 1, false, 0]);
    assert.equal(a[6](), true); h.c.chatId = 'second'; assert.equal(a[6](), false);
    h.c.chatId = 'first'; h.settings.enabled = false; assert.equal(a[6](), false);
});
test('quiet, impersonation, dry-run, stop and chat events clear rules; settings apply next generation', () => {
    const h = harness(); h.scope.initProactiveMessages(); h.scope.initProactiveMessages(); assert.equal(typeof h.scope.bluebirdGenerationInterceptor, 'function');
    for (const t of ['quiet', 'impersonate', 'unknown']) assert.equal(h.prepare(t)[1], '');
    for (const [n, args] of [['GENERATION_STARTED', ['normal', {}, true]], ['CHAT_CHANGED', []], ['GENERATION_STOPPED', []], ['GENERATION_ENDED', []]]) {
        assert.match(h.prepare('normal')[1], /<bb-phone>/); h.events.get(n)(...args); assert.equal(h.calls.at(-1)[1], '');
    }
    h.scope.setSetting('proactiveEnabled', false); assert.equal(h.calls.at(-1)[1], ''); assert.match(h.prepare('normal')[1], /已关闭/);
});
