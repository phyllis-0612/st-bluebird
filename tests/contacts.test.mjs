import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = name => fs.readFileSync(new URL(`../src/${name}.js`, import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export /g, '');
function harness() {
    const entries = { 7: { uid: 7, comment: '阿澜', content: '住在海港的信使' }, 8: { uid: 8, comment: '海港', content: '一座城市' } };
    let requests = 0, saves = 0;
    const settings = { proactiveLevel: 'normal', recentStoryCount: 20, phoneHistoryCount: 30, phoneReplyTokens: 1024,
        phoneModel: '', thinkTags: ['think'], statusTags: ['status'], bodyTag: 'content' };
    const context = { characterId: 0, groupId: null, name1: '鱼仔', chat: [], characters: [{ avatar: 'role.png', name: '陆', description: '角色卡主角', data: { extensions: { world: '主书' } } }],
        extensionSettings: {}, loadWorldInfo: async book => ({ entries }), generateRaw: async request => {
            requests++; return JSON.stringify([{ name: '阿澜', source: 'world:副书:7', person: true, level: 'clingy' },
                { name: '海港', source: 'world:副书:8', person: false, level: 'normal' }]);
        } };
    const scope = vm.createContext({ ctx: () => context, getSettings: () => settings,
        setSetting: (key, value) => { settings[key] = value; saves++; }, world_info: { charLore: [{ name: 'role', extraBooks: ['副书'] }] } });
    vm.runInContext(['messages', 'api', 'contacts', 'phone-memory'].map(source).join('\n'), scope);
    return { scope, context, entries, settings, requests: () => requests, saves: () => saves };
}

test('primary and auxiliary books are scanned in batches; nonpeople stay unchecked', async () => {
    const h = harness();
    assert.deepEqual(Array.from(h.scope.boundBooks(h.context)), ['主书', '副书']);
    const candidates = await h.scope.extractContacts();
    assert.equal(h.requests(), 1);
    assert.equal(candidates.find(c => c.name === '阿澜').selected, true);
    assert.equal(candidates.find(c => c.name === '海港').selected, false);
    h.scope.saveContacts(candidates.filter(c => c.selected));
    assert.equal(h.saves(), 1);
    assert.equal(h.settings.contacts['card:role.png'][0].source.uid, 7);
    assert.equal(JSON.stringify(h.settings.contacts).includes('住在海港'), false);
});

test('legacy voice binding migrates and switching services preserves each contact’s separate voice', () => {
    const h = harness();
    h.settings.contacts = { 'card:role.png': [{ name: '陆', source: { type: 'card' }, level: 'normal', voice: { provider: 'elevenlabs', voiceId: 'e-1' } }] };
    const first = h.scope.selectedContacts()[0];
    assert.equal(first.voice.elevenlabs, 'e-1');
    h.scope.saveContacts([{ ...first, voice: { ...first.voice, minimax: 'm-1' } }]);
    assert.equal(h.settings.contacts['card:role.png'][0].voice.elevenlabs, 'e-1');
    assert.equal(h.settings.contacts['card:role.png'][0].voice.minimax, 'm-1');
    assert.equal(h.scope.selectedContacts()[0].voice.minimax, 'm-1');
});

test('NPC phone request rereads latest entry and excludes absent scenes and global memory', async () => {
    const h = harness(); const contact = { name: '阿澜', source: { type: 'world', book: '副书', uid: 7 }, level: 'clingy' };
    h.scope.saveContacts([contact]);
    h.context.chat = [
        { mes: '<content>秘密藏在桥下</content><bb-present>陆</bb-present>' },
        { mes: '<content>海边相遇</content><bb-present>阿澜</bb-present>' },
        { mes: '<content>一起散步</content>' },
        { mes: '<content>柜中钥匙</content><bb-present>无</bb-present>' },
        { mes: '<content>更远的计划</content><bb-present>未知</bb-present>' },
    ];
    h.context.chatMetadata = { autoSummaryAdv_v1: { segments: [{ startFloor: 0, endFloor: 4, text: '全局秘密' }] } };
    h.context.extensionSettings.autoSummaryWorldbookAdv = { storageMode: 'inject' };
    h.entries[7].content = '现在改成了港口医生';
    const request = await h.scope.buildPhoneRequest(h.context, contact, { messages: [] }, h.settings);
    assert.match(request.prompt, /现在改成了港口医生/);
    assert.match(request.prompt, /海边相遇/); assert.match(request.prompt, /一起散步/);
    assert.match(request.prompt, /你只知道上面这些你在场时发生的事/);
    assert.doesNotMatch(request.prompt, /秘密藏在桥下|柜中钥匙|更远的计划|全局秘密/);
});

test('bad source IDs cannot be invented by extractor; missing referenced entry fails clearly', async () => {
    const h = harness();
    assert.equal(h.scope.parseCandidates('[{"name":"陌生人","source":"world:fake:1","person":true}]', []).length, 0);
    await assert.rejects(h.scope.readContactSource(h.context, { name: '阿澜', source: { type: 'world', book: '副书', uid: 999 } }), /重新提取/);
});
