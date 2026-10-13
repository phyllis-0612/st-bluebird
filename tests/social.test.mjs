import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { maskExcluded, activeSwipe, activeSwipeKey, hidePhoneTags } from '../src/messages.js';

const source = fs.readFileSync(new URL('../src/social.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export /g, '');
const event = (platform, kind, id, author, text, postId = '') => ({ platform, kind, id, author, text, postId });
const block = events => `<bb-social>\n${events.map(x => JSON.stringify(x)).join('\n')}\n</bb-social>`;

function harness() {
    let saves = 0, failing = false, busy = false, output = '', requests = 0;
    const c = { chat: [], characterId: 0, groupId: null, chatId: 'story-a', characters: [{ avatar: 'lu.png' }],
        name1: '鱼仔', async saveChat() { saves++; if (failing) throw new Error('save failed'); } };
    const settings = { enabled: true, socialEnabled: true, socialPlatforms: { moments: true, weibo: true, forum: true, video: true },
        socialFriends: { 'card:lu.png': ['陆'] }, thinkTags: ['灵魂疏理'], recentStoryCount: 10, bodyTag: 'content', statusTags: [] };
    const scope = vm.createContext({ ctx: () => c, getSettings: () => settings, setSetting: (k, v) => { settings[k] = v; },
        maskExcluded, activeSwipe, activeSwipeKey, visibleStory: () => '<content>现在到滨城</content>',
        isGenerationBusy: () => busy, captureCurrentChat: () => ({ id: c.chatId, chat: c.chat }),
        currentChatMatches: owner => owner.id === c.chatId && owner.chat === c.chat,
        rebuildChatState() {}, async requestBluebirdRaw() { requests++; return output; } });
    vm.runInContext(source, scope);
    return { scope, c, settings, setOutput(x) { output = x; }, setFail(x) { failing = x; },
        setBusy(x) { busy = x; }, stats: () => ({ saves, requests }) };
}

test('private feed only shows added friends and their visible comments while public Weibo includes strangers', () => {
    const h = harness();
    h.c.chat.push({ mes: block([
        event('moments', 'post', 'm1', '陆', '到滨城了'),
        event('moments', 'comment', 'c1', '陌生人', '欢迎', 'm1'),
        event('moments', 'like', 'l1', '陌生人', '', 'm1'),
        event('moments', 'comment', 'c2', '陆', '下雪了', 'm1'),
        event('moments', 'post', 'm2', '陌生人', '秘密'),
        event('weibo', 'post', 'w1', '陌生人', '公开热搜'),
        event('weibo', 'comment', 'c3', '其他网友', '看到啦', 'w1'),
    ]) });
    const posts = h.scope.socialState(h.c, h.settings).posts;
    assert.deepEqual(Array.from(posts.map(p => p.id)), ['w1', 'm1']);
    assert.deepEqual(Array.from(posts.find(p => p.id === 'm1').comments.map(p => p.author)), ['陆']);
    assert.deepEqual(Array.from(posts.find(p => p.id === 'm1').likes), []);
    assert.equal(posts.find(p => p.id === 'w1').comments[0].author, '其他网友');
    assert.doesNotMatch(h.scope.socialHistoryReminder(h.c, h.settings), /秘密|陌生人：欢迎/);
});

test('thought examples, malformed JSON and unknown platforms are ignored; tags remain display-only', () => {
    const h = harness();
    const raw = `<灵魂疏理>${block([event('weibo', 'post', 'hidden', '路人', '假的')])}</灵魂疏理>\n`
        + block([event('weibo', 'post', 'visible', '路人', '<img onerror=bad>'),
            event('elsewhere', 'post', 'other', '路人', '未知')]) + '\n正文';
    const items = h.scope.parseSocialEvents(raw, h.settings.thinkTags);
    assert.equal(items.length, 1); assert.equal(items[0].id, 'visible');
    assert.equal(hidePhoneTags(raw).includes('<bb-social>'), false);
});

test('swipe and edits derive the feed from the active source; no old variant leaks', () => {
    const h = harness(), first = block([event('weibo', 'post', 'first', '网友', '旧版')]);
    const second = block([event('weibo', 'post', 'second', '网友', '新版')]);
    const f = { mes: first, swipes: [first, second], swipe_id: 0 };
    h.c.chat = [f];
    assert.equal(h.scope.socialState(h.c, h.settings).posts[0].id, 'first');
    assert.equal(h.scope.socialState(h.c, h.settings, 'swipe').posts.length, 0);
    f.mes = second; f.swipe_id = 1;
    assert.equal(h.scope.socialState(h.c, h.settings).posts[0].id, 'second');
    f.mes = '编辑后删除了事件';
    assert.equal(h.scope.socialState(h.c, h.settings).posts.length, 0);
    h.c.chat.splice(0, 1);
    assert.equal(h.scope.socialState(h.c, h.settings).posts.length, 0);
});

test('feature toggles determine input rule estimate and story prompt; a blank feed costs no history', () => {
    const h = harness();
    const estimate = h.scope.socialTokenEstimate(h.settings, ['陆']);
    assert.ok(estimate.shared > 0 && estimate.platforms.weibo > 0);
    assert.ok(estimate.total > estimate.shared);
    const prompt = h.scope.buildSocialPrompt(h.c, h.settings, 'normal');
    assert.match(prompt, /剧情明确|微博是公开平台|朋友圈是私密/);
    assert.doesNotMatch(prompt, /已发生的社交动态/);
    h.settings.socialEnabled = false;
    assert.equal(h.scope.buildSocialPrompt(h.c, h.settings, 'normal'), '');
    assert.equal(h.scope.socialTokenEstimate(h.settings).total, 0);
    h.settings.socialEnabled = true; h.settings.socialPlatforms = { moments: true, weibo: false, forum: false, video: false };
    h.settings.socialFriends = {};
    assert.equal(h.scope.buildSocialPrompt(h.c, h.settings, 'normal'), '');
});

test('manual refresh on a user floor saves public posts; likes and comments persist, failed saves roll back', async () => {
    const h = harness();
    h.c.chat.push({ mes: '用户问了一句', is_user: true, swipes: ['用户问了一句'], swipe_id: 0 });
    h.setOutput(block([event('weibo', 'post', 'public1', '路人', '剧情里的雪') ]));
    assert.equal(await h.scope.refreshSocial('weibo'), 1);
    let post = h.scope.socialState(h.c, h.settings).posts[0];
    assert.equal(post.author, '路人');
    await h.scope.actOnSocialPost(post, 'like');
    post = h.scope.socialState(h.c, h.settings).posts[0]; assert.equal(post.liked, true);
    await h.scope.actOnSocialPost(post, 'comment', '路上小心');
    assert.equal(h.scope.socialState(h.c, h.settings).posts[0].comments.at(-1).text, '路上小心');
    const before = h.c.chat[0].mes; h.setFail(true);
    await assert.rejects(h.scope.actOnSocialPost(post, 'unlike'), /save failed/);
    assert.equal(h.c.chat[0].mes, before);
    assert.equal(h.c.chat[0].swipes[0], before);
    assert.equal(h.stats().requests, 1);
});

test('Moments refresh rejects strangers and chat switches; closed platform makes no API request', async () => {
    const h = harness(); h.c.chat.push({ mes: '剧情' });
    h.setOutput(block([event('moments', 'post', 'm1', '陌生人', '私人动态')]));
    await assert.rejects(h.scope.refreshSocial('moments'), /非好友/);
    assert.equal(h.stats().saves, 0);
    h.settings.socialPlatforms.moments = false;
    await assert.rejects(h.scope.refreshSocial('moments'), /先在设置/);
    assert.equal(h.stats().requests, 1);
    h.settings.socialPlatforms.moments = true;
    h.scope.setSocialFriend('何', true, h.c);
    assert.ok(h.scope.socialFriends(h.c).includes('何'));
    h.c.characterId = 1; h.c.characters.push({ avatar: 'he.png' });
    assert.deepEqual(Array.from(h.scope.socialFriends(h.c)), []);
});
