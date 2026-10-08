import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = name => fs.readFileSync(new URL(`../src/${name}.js`, import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export /g, '');

function harness() {
    let context, serial = 0, saves = 0, renders = 0;
    const errors = [];
    const timers = new Map();
    const floor = { mes: '<bb-phone>陆|transfer|20|备注\n陆|text|你好</bb-phone>', swipe_id: 0, extra: { display_text: '旧显示缓存' } };
    floor.swipes = [floor.mes, '备用'];
    context = { chat: [floor], chatId: 'a', chatMetadata: {}, characters: [{ avatar: 'a.png' }], characterId: 0,
        saveChat: async () => { saves++; }, updateMessageBlock: () => { renders++; } };
    const scope = vm.createContext({ world_info: {}, ctx: () => context, getSettings: () => ({ thinkTags: ['think'] }),
        crypto: { randomUUID: () => 'id-' + (++serial) }, console: { ...console, error: (...args) => errors.push(args) },
        setTimeout: fn => { const id = ++serial; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id) });
    vm.runInContext(source('messages') + '\n' + source('contacts') + '\n' + source('chat-store'), scope);
    const rebuild = () => scope.rebuildChatState();
    const transfer = () => scope.getChatState().conversations[0].messages.find(m => m.type === 'transfer');
    return { scope, floor, rebuild, transfer, timers, context, errors,
        switchChat() { context = { ...context, chat: [], chatMetadata: {}, chatId: 'b' }; },
        counts: () => ({ saves, renders }) };
}

test('stable floor IDs, unread writes preserve other chat metadata and pending records', async () => {
    const h = harness(); h.context.chatMetadata.bluebird = { pending: [{ content: '暂存' }], custom: 7 };
    h.rebuild(); const id = h.floor.extra.bluebird.floorId;
    assert.equal(h.scope.getChatState().unread, 2);
    h.scope.markConversationRead('name:陆');
    assert.equal(h.scope.getChatState().unread, 0);
    assert.equal(h.context.chatMetadata.bluebird.pending[0].content, '暂存');
    assert.equal(h.context.chatMetadata.bluebird.custom, 7);
    const callbacks = [...h.timers.values()]; h.timers.clear();
    for (const cb of callbacks) await cb();
    assert.equal(h.counts().saves, 1);
    h.rebuild(); assert.equal(h.floor.extra.bluebird.floorId, id); assert.equal(h.scope.getChatState().unread, 0);
});

test('transfer commits only the current swipe, clears display cache and cannot run twice', async () => {
    const h = harness(); h.rebuild(); const id = h.transfer().id;
    await h.scope.processTransfer(id, 'accepted');
    assert.match(h.floor.mes, /20\|备注\|accepted/);
    assert.equal(h.floor.swipes[0], h.floor.mes); assert.equal(h.floor.swipes[1], '备用');
    assert.equal(h.floor.extra.display_text, undefined);
    const reloaded = h.scope.buildState(JSON.parse(JSON.stringify(h.context.chat)));
    assert.equal(reloaded.conversations[0].messages.find(m => m.type === 'transfer').status, 'accepted');
    assert.deepEqual(h.counts(), { saves: 1, renders: 1 });
    await assert.rejects(h.scope.processTransfer(id, 'returned'), /已经处理/);
});

test('failed save rolls back only its own edit and display cache', async () => {
    const h = harness(); h.rebuild(); const before = h.floor.mes;
    h.context.saveChat = async () => { throw Error('offline'); };
    await assert.rejects(h.scope.processTransfer(h.transfer().id, 'accepted'), /offline/);
    assert.equal(h.floor.mes, before); assert.equal(h.floor.swipes[0], before);
    assert.equal(h.floor.extra.display_text, '旧显示缓存');
});

test('save failure cannot overwrite an edit made while awaiting the server', async () => {
    const h = harness(); h.rebuild();
    h.context.saveChat = async () => { h.floor.mes = '用户刚编辑的正文'; throw Error('offline'); };
    await assert.rejects(h.scope.processTransfer(h.transfer().id, 'accepted'));
    assert.equal(h.floor.mes, '用户刚编辑的正文');
});

test('deleted message, changed chat, generation and an unfinished save reject unsafe operations', async () => {
    const h = harness(); h.rebuild(); const id = h.transfer().id;
    h.scope.setGenerationActive(true);
    await assert.rejects(h.scope.processTransfer(id, 'accepted'), /生成结束/);
    h.scope.setGenerationActive(false);
    let finish; h.context.saveChat = () => new Promise(resolve => { finish = resolve; });
    const job = h.scope.processTransfer(id, 'accepted');
    await assert.rejects(h.scope.processTransfer(id, 'returned'), /正在保存/);
    finish(); await job;
    h.context.chat.length = 0; h.rebuild();
    await assert.rejects(h.scope.processTransfer(id, 'returned'), /不存在/);
    h.switchChat();
    await assert.rejects(h.scope.processTransfer(id, 'returned'), /聊天已切换/);
    assert.equal(h.scope.getChatState().conversations.length, 0);
});

test('rebuild before writing catches edits and moved source lines', async () => {
    const h = harness(); h.rebuild(); const id = h.transfer().id;
    h.floor.mes = '新正文\n' + h.floor.mes;
    await h.scope.processTransfer(id, 'returned');
    assert.match(h.floor.mes, /^新正文\n/);
    assert.match(h.floor.mes, /20\|备注\|returned/);
});

test('old-chat timers cannot save a new chat and copied floors get distinct IDs', async () => {
    const h = harness(); h.rebuild();
    h.context.chat.push(structuredClone(h.floor)); h.rebuild();
    assert.notEqual(h.context.chat[0].extra.bluebird.floorId, h.context.chat[1].extra.bluebird.floorId);
    const callbacks = [...h.timers.values()]; h.timers.clear(); h.switchChat();
    for (const cb of callbacks) await cb();
    assert.equal(h.counts().saves, 0);
});

test('render failure after a successful save does not roll back committed text', async () => {
    const h = harness(); h.rebuild();
    h.context.updateMessageBlock = () => { throw Error('render failed'); };
    await h.scope.processTransfer(h.transfer().id, 'accepted');
    assert.match(h.floor.mes, /accepted/);
    assert.equal(h.errors.length, 1);
});

test('native swipe extra replacement and deleting another swipe preserve read identity', () => {
    const h = harness(); h.rebuild();
    const id0 = h.floor.extra.bluebird.floorId;
    h.scope.markConversationRead('name:陆');
    const text0 = h.floor.mes;
    h.floor.swipe_id = 1; h.floor.mes = '<bb-phone>陆|text|另一版本</bb-phone>';
    h.floor.swipes[1] = h.floor.mes;
    h.floor.extra = structuredClone(h.floor.swipe_info[1].extra); h.rebuild();
    assert.equal(h.floor.extra.bluebird.floorId, id0);
    assert.equal(h.scope.getChatState().unread, 1);
    h.scope.markConversationRead('name:陆');
    // 删除第 0 个 swipe，第 1 个版本移动到下标 0。
    h.floor.swipes.shift(); h.floor.swipe_info.shift(); h.floor.swipe_id = 0;
    h.floor.extra = structuredClone(h.floor.swipe_info[0].extra); h.rebuild();
    assert.equal(h.scope.getChatState().unread, 0);
    assert.notEqual(h.floor.mes, text0);
});

test('save failure restores the old variant without overwriting a newly selected swipe', async () => {
    const h = harness(); h.rebuild(); const original = h.floor.mes;
    h.context.saveChat = async () => {
        h.floor.swipe_id = 1; h.floor.mes = h.floor.swipes[1];
        h.floor.extra = structuredClone(h.floor.swipe_info[1].extra);
        throw Error('offline');
    };
    await assert.rejects(h.scope.processTransfer(h.transfer().id, 'accepted'));
    assert.equal(h.floor.mes, '备用'); assert.equal(h.floor.swipes[0], original);
});

test('an unpaired start event heals when native generation controls are idle', async () => {
    const h = harness(); h.rebuild();
    let clock = 1000;
    const stop = { style: { display: 'none' } };
    h.scope.Date = class extends Date { static now() { return clock; } };
    h.scope.document = { body: { dataset: {} }, getElementById: () => stop };
    h.scope.getComputedStyle = node => node.style;
    h.scope.setGenerationActive(true);
    // 请求准备阶段仍保护写回，但不能无限挂着。
    await assert.rejects(h.scope.processTransfer(h.transfer().id, 'accepted'), /生成结束/);
    clock += 2000;
    await h.scope.processTransfer(h.transfer().id, 'accepted');
    assert.match(h.floor.mes, /accepted/);
    assert.equal(h.scope.isGenerationBusy(), false);
});

test('native busy signals protect transfers even if a start event was missed', async () => {
    const h = harness(); h.rebuild();
    const body = { dataset: { generating: 'true' } }, stop = { style: { display: 'none' } };
    h.scope.document = { body, getElementById: () => stop };
    h.scope.getComputedStyle = node => node.style;
    await assert.rejects(h.scope.processTransfer(h.transfer().id, 'returned'), /生成结束/);
    delete body.dataset.generating; stop.style.display = 'flex';
    await assert.rejects(h.scope.processTransfer(h.transfer().id, 'returned'), /生成结束/);
    stop.style.display = 'none';
    await h.scope.processTransfer(h.transfer().id, 'returned');
    assert.match(h.floor.mes, /returned/);
});
