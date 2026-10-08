import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = name => fs.readFileSync(new URL(`../src/${name}.js`, import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export /g, '');
function harness() {
    let serial = 0, saves = 0, context;
    const timers = new Map(), events = new Map(), prompts = new Map(), errors = [];
    const settings = { enabled: true, thinkTags: ['think'], statusTags: ['status'], bodyTag: 'content', recentStoryCount: 2,
        phoneHistoryCount: 30, phoneReplyTokens: 1024, phoneModel: '' };
    const c = { chat: [{ mes: '<content>她出门了</content><status>不能进记忆</status>', is_user: false, extra: {} }], chatMetadata: {},
        chatId: 'first', characterId: 0, groupId: null, name1: '鱼仔', mainApi: 'openai',
        characters: [{ name: '陆', avatar: 'lu.png', description: '温柔的{{char}}', personality: '稳重', scenario: '认识{{user}}' }],
        extensionSettings: {}, saveChat: async () => { saves++; }, updateMessageBlock() {},
        generateRaw: async () => '陆|text|好，我记住了', setExtensionPrompt: (key, text) => prompts.set(key, text),
        eventTypes: Object.fromEntries(['GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'MESSAGE_RECEIVED', 'CHAT_CHANGED',
            'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'CHAT_COMPLETION_SETTINGS_READY'].map(n => [n, n])),
        eventSource: { on(key, fn) { if (!events.has(key)) events.set(key, []); events.get(key).push(fn); },
            removeListener(key, fn) { events.set(key, (events.get(key) || []).filter(f => f !== fn)); } },
    };
    context = c;
    const scope = vm.createContext({ world_info: {}, ctx: () => context, getSettings: () => settings, onSettingChanged() {},
        setTimeout(fn, delay) { const id = ++serial; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
        crypto: { randomUUID: () => 'id-' + (++serial) }, console, toastr: { error: t => errors.push(t), info: t => errors.push(t) } });
    vm.runInContext(['messages', 'api', 'contacts', 'chat-store', 'phone-memory', 'phone-chat'].map(source).join('\n'), scope);
    scope.rebuildChatState(); scope.initPhoneChat();
    const emit = async (key, ...args) => { for (const fn of events.get(key) || []) await fn(...args); };
    const flush = async delay => { const list = [...timers.entries()].filter(([, t]) => t.delay === delay); for (const [id, t] of list) { timers.delete(id); await t.fn(); } };
    return { scope, c, settings, timers, events, prompts, errors, emit, flush, saves: () => saves,
        switchChat() { context = { ...c, chat: [{ mes: '另一段剧情' }], chatId: 'other', chatMetadata: {} }; scope.rebuildChatState(); return context; },
        pending: () => c.chatMetadata.bluebird.pending,
        start(type = 'normal') { scope.preparePendingGeneration(type); },
        batch() { return vm.runInContext('batch', scope); },
        responseFloor() { const f = { mes: '新的剧情', is_user: false, extra: {} }; c.chat.push(f); return f; },
    };
}

test('sending all five types persists, reloads and does not create story floors; validates amounts', async () => {
    const h = harness();
    for (const [type, content, note] of [['text', '我到了'], ['voice', '听我说'], ['image', '落雨的车窗'], ['transfer', '20.50', '车费'], ['location', '便利店', '等雨']]) {
        await h.scope.sendPhoneMessage('陆', type, content, note);
    }
    assert.equal(h.pending().length, 5); assert.equal(h.c.chat.length, 1); assert.equal(h.saves(), 5); assert.equal(h.scope.getPhoneStatus('陆').phase, 'idle'); assert.equal(h.timers.size, 0);
    h.scope.rebuildChatState(); const messages = h.scope.getChatState().conversations[0].messages;
    assert.equal(messages.length, 5); assert.ok(messages.every(m => m.pending && m.isSelf));
    await assert.rejects(h.scope.sendPhoneMessage('陆', 'transfer', '0'), /金额/);
    await assert.rejects(h.scope.sendPhoneMessage('别人', 'text', '你好'), /通讯录/);
});

test('multiple sends make no API calls until one explicit reply request sees the whole conversation', async () => {
    const h = harness(); let requests = 0, request;
    h.c.generateRaw = async r => { requests++; request = r; return '陆|text|两条都看到了\n陆|voice|早点休息'; };
    await h.scope.sendPhoneMessage('陆', 'text', '第一条'); await h.scope.sendPhoneMessage('陆', 'text', '第二条');
    assert.equal(requests, 0); assert.equal(h.timers.size, 0);
    await h.scope.requestPhoneReply('陆');
    assert.equal(requests, 1); assert.match(request.prompt, /温柔的陆/); assert.match(request.prompt, /认识鱼仔/);
    assert.match(request.prompt, /她出门了/); assert.doesNotMatch(request.prompt, /不能进记忆/);
    assert.match(request.prompt, /第一条/); assert.match(request.prompt, /第二条/); assert.equal(request.trimNames, false);
    assert.equal(h.pending().length, 4); assert.equal(h.scope.getPhoneStatus('陆').phase, 'idle');
});

test('switching chat or editing during an in-flight reply cannot write stale results', async () => {
    for (const action of ['switch', 'edit']) {
        const h = harness(); let resolve;
        h.c.generateRaw = () => new Promise(r => { resolve = r; });
        await h.scope.sendPhoneMessage('陆', 'text', '等你'); const running = h.scope.requestPhoneReply('陆');
        for (let i = 0; i < 10 && !resolve; i++) await Promise.resolve();
        assert.equal(typeof resolve, 'function');
        if (action === 'switch') { const other = h.switchChat(); await h.emit('CHAT_CHANGED'); assert.equal(other.chatMetadata.bluebird.pending.length, 0); }
        else await h.emit('MESSAGE_EDITED');
        resolve('陆|text|旧回复'); await running;
        assert.equal(h.pending().length, 1);
    }
});

test('invalid output is kept out of pending and can retry without resending the user message', async () => {
    const h = harness(); h.c.generateRaw = async () => '我|text|冒充用户';
    await h.scope.sendPhoneMessage('陆', 'text', '你好'); await h.scope.requestPhoneReply('陆');
    assert.equal(h.pending().length, 1); assert.equal(h.scope.getPhoneStatus('陆').phase, 'error');
    h.c.generateRaw = async () => '陆|text|你好呀'; await h.scope.requestPhoneReply('陆');
    assert.equal(h.pending().length, 2); assert.equal(h.pending()[0].fields[2], '你好');
});

test('model override only changes the marked request and never mutates connection settings', async () => {
    const h = harness(); h.settings.phoneModel = 'account-flash'; let own, other;
    h.c.generateRaw = async request => {
        own = { model: 'main-model', messages: [{ role: 'system', content: request.systemPrompt }] };
        other = { model: 'main-model', messages: [{ content: 'main story' }] };
        await h.emit('CHAT_COMPLETION_SETTINGS_READY', other); await h.emit('CHAT_COMPLETION_SETTINGS_READY', own);
        return '陆|text|收到';
    };
    await h.scope.sendPhoneMessage('陆', 'text', '你好'); await h.scope.requestPhoneReply('陆');
    assert.equal(own.model, 'account-flash'); assert.equal(other.model, 'main-model');
    assert.equal((h.events.get('CHAT_COMPLETION_SETTINGS_READY') || []).length, 0);
});

test('cancel, failure, quiet and continue never clear pending; successful generation lands once on previous user floor', async () => {
    const h = harness(); await h.scope.sendPhoneMessage('陆', 'text', '我到家了'); await h.scope.requestPhoneReply('陆');
    h.start('quiet'); assert.equal(h.batch(), null); h.start('continue'); assert.equal(h.batch(), null);
    h.c.chat.push({ mes: '主线下一句', is_user: true, extra: {}, swipes: ['主线下一句'], swipe_id: 0 });
    h.start(); assert.match(h.prompts.get('bluebird-pending'), /我到家了/);
    await h.emit('GENERATION_ENDED'); await h.flush(0); assert.equal(h.pending().length, 2);
    h.start(); h.responseFloor(); await h.emit('GENERATION_STOPPED'); await h.emit('MESSAGE_RECEIVED', 2, 'normal'); await h.emit('GENERATION_ENDED'); await h.flush(0);
    assert.equal(h.pending().length, 2); assert.doesNotMatch(h.c.chat[1].mes, /bb-phone/);
    h.c.chat.pop(); h.start(); h.responseFloor(); await h.emit('MESSAGE_RECEIVED', 2, 'normal'); await h.emit('GENERATION_ENDED'); await h.flush(0);
    assert.equal(h.pending().length, 0); assert.match(h.c.chat[1].mes, /source="phone" chat="陆"/); assert.match(h.c.chat[1].mes, /我到家了/);
    assert.equal(h.c.chat[1].swipes[0], h.c.chat[1].mes); assert.equal(h.prompts.get('bluebird-pending'), '');
    await h.emit('GENERATION_ENDED'); await h.flush(0); assert.equal((h.c.chat[1].mes.match(/<bb-phone/g) || []).length, 1);
});

test('stream errors emitting MESSAGE_RECEIVED are rejected; success works when ENDED arrives first', async () => {
    const h = harness(); await h.scope.sendPhoneMessage('陆', 'text', '你好');
    h.start(); h.responseFloor(); h.c.streamingProcessor = { messageId: 1, isStopped: true, abortController: { signal: { aborted: true } } };
    await h.emit('GENERATION_ENDED'); await h.emit('MESSAGE_RECEIVED', 1, 'normal'); await h.flush(0); assert.equal(h.pending().length, 1);
    h.c.chat.pop(); h.c.streamingProcessor = null; h.start(); h.responseFloor(); await h.emit('GENERATION_ENDED'); await h.flush(0);
    await h.emit('MESSAGE_RECEIVED', 1, 'normal'); await h.flush(0); assert.equal(h.pending().length, 0);
});

test('landing retains post-snapshot messages and read state, rejects altered target and rolls back failed saves', async () => {
    const h = harness(); await h.scope.sendPhoneMessage('陆', 'text', '第一条'); await h.scope.requestPhoneReply('陆');
    h.scope.markConversationRead('name:陆'); h.start(); const batch = h.batch();
    await h.scope.appendPendingMessages('陆', [['我', 'text', '后来的一条']]); h.responseFloor();
    await h.scope.landPendingMessages(batch, 1);
    assert.equal(h.pending().length, 1); assert.equal(h.pending()[0].fields[2], '后来的一条'); assert.equal(h.scope.getChatState().unread, 0);
    h.start(); const changed = h.batch(); h.c.chat.at(-1).mes = '编辑了目标'; h.responseFloor();
    assert.equal(await h.scope.landPendingMessages(changed, 2), false); assert.equal(h.pending().length, 1);
    h.c.chat.pop(); h.start(); const failing = h.batch(); h.responseFloor(); const oldText = failing.floor.mes;
    h.c.saveChat = async () => { throw Error('offline'); };
    await assert.rejects(h.scope.landPendingMessages(failing, 2), /offline/); assert.equal(failing.floor.mes, oldText); assert.equal(h.pending().length, 1);
});

test('pending transfers can be accepted and a display failure cannot undo persisted landing', async () => {
    const h = harness(); await h.scope.appendPendingMessages('陆', [['陆', 'transfer', '12', '车费']]);
    await h.scope.processTransfer(h.pending()[0].id, 'accepted'); assert.equal(h.pending()[0].fields[4], 'accepted');
    h.c.updateMessageBlock = () => { throw Error('render'); }; h.start(); const batch = h.batch(); h.responseFloor();
    assert.equal(await h.scope.landPendingMessages(batch, 1), true); assert.equal(h.pending().length, 0); assert.match(h.c.chat[0].mes, /accepted/);
});

test('memory uses current valid segments and threads plus visible story, with recent-story fallback', async () => {
    const h = harness(); h.c.chat = [{ mes: '隐藏原文', extra: { asAdvHidden: true } }, { mes: '<think>秘密</think><content>第一段</content>' }, { mes: '<content>第二段</content>' }, { mes: '<content>第三段</content>' }];
    h.c.extensionSettings.autoSummaryWorldbookAdv = { storageMode: 'inject' };
    h.c.chatMetadata.autoSummaryAdv_v1 = { segments: [{ layerId: 's1', startFloor: 0, endFloor: 0, text: '有效总结' }, { layerId: 's9', startFloor: 10, endFloor: 12, text: '过期总结' }], threadNodes: [{ layerId: 's1', text: '有效脉络' }, { layerId: 's9', text: '过期脉络' }] };
    const request = await h.scope.buildPhoneRequest(h.c, { name: '陆' }, { messages: [] }, h.settings);
    assert.match(request.prompt, /有效总结/); assert.match(request.prompt, /有效脉络/); assert.match(request.prompt, /第一段/);
    assert.doesNotMatch(request.prompt, /过期|隐藏原文|秘密/);
    delete h.c.chatMetadata.autoSummaryAdv_v1;
    const fallback = await h.scope.buildPhoneRequest(h.c, { name: '陆' }, { messages: [] }, h.settings);
    assert.doesNotMatch(fallback.prompt, /第一段/); assert.match(fallback.prompt, /第二段/); assert.match(fallback.prompt, /第三段/);
});

test('worldbook memory reads only enabled summaries for this chat and selected type', async () => {
    const h = harness(); h.c.extensionSettings.autoSummaryWorldbookAdv = { storageMode: 'lorebook', selectedSummaryType: 'large' };
    h.c.characters[0].data = { extensions: { world: '绑定世界书' } };
    h.c.loadWorldInfo = async () => ({ entries: { 0: { comment: '大总结-first-1-1', content: '有效世界书', disable: false }, 1: { comment: '小总结-first-1-1', content: '错误类型' }, 2: { comment: '大总结-other-1-1', content: '其他聊天' }, 3: { comment: '大总结-first-1-1', content: '停用总结', disable: true } } });
    const memory = await h.scope.readKnottedMemory(h.c);
    assert.equal(memory.text, '有效世界书');
});

test('protocol escapes closing tags and attribute quotes without losing literal user text', () => {
    const h = harness(), name = '陆"<>&';
    const fields = ['我', 'text', '</bb-phone>\nA|B\\u003c'];
    const block = `<bb-phone source="phone" chat="${h.scope.escapeAttribute(name)}">${h.scope.serializeFields(fields)}</bb-phone>`;
    const parsed = h.scope.parseFloor(block).messages[0];
    assert.equal(parsed.chatName, name); assert.equal(parsed.content, fields[2]); assert.equal(parsed.fields[0], '我');
});
