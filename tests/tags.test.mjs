import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseFloor, detectChatTags, maskExcluded, hidePhoneTags } from '../src/messages.js';
const source = name => fs.readFileSync(new URL(`../src/${name}.js`, import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export /g, '');

test('Chinese tag names survive settings normalization and a reopened settings read', () => {
    let saved = 0;
    const context = { extensionSettings: {}, saveSettingsDebounced() { saved++; } };
    const scope = vm.createContext({ SillyTavern: { getContext: () => context }, window: { matchMedia: () => ({ matches: false }) } });
    vm.runInContext(source('settings'), scope);
    const tags = scope.parseTagNames('think, <灵魂疏理>，<状态栏>');
    scope.setSetting('thinkTags', tags);
    scope.setSetting('statusTags', ['status', '状态栏']);
    assert.deepEqual(Array.from(scope.getSettings().thinkTags), ['think', '灵魂疏理', '状态栏']);
    assert.ok(scope.getSettings().statusTags.includes('状态栏'));
    assert.equal(saved, 2);
});

test('Chinese thought masks phone messages and Chinese status is removed from phone story', () => {
    const text = '<灵魂疏理><bb-phone>幻觉|text|秘密</bb-phone></灵魂疏理><content>真实剧情</content><状态栏>体力80</状态栏>';
    assert.equal(parseFloor(text, { thinkTags: ['灵魂疏理'] }).messages.length, 0);
    const scope = vm.createContext({ maskExcluded, hidePhoneTags });
    vm.runInContext(source('phone-memory'), scope);
    const body = scope.storyBody(text, { thinkTags: ['灵魂疏理'], statusTags: ['状态栏'], bodyTag: 'content' });
    assert.equal(body, '真实剧情');
    assert.equal(scope.storyBody('<正文>风吹过</正文><状态栏>隐藏</状态栏>',
        { thinkTags: [], statusTags: ['状态栏'], bodyTag: '正文' }), '风吹过');
});

test('scanner uses every active floor, does not pair tags across floors or list Bluebird protocol', () => {
    const names = detectChatTags([
        { mes: '<灵魂疏理>内容</灵魂疏理><状态栏 a="1">体力</状态栏><bb-phone>陆|text|你好</bb-phone>' },
        { mes: '<状态栏>心情</状态栏><另一个>未闭合', swipes: ['<旧标签>旧</旧标签>'] },
        { mes: '</另一个>' },
    ]);
    assert.deepEqual(names, ['灵魂疏理', '状态栏']);
});
