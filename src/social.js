// 社交页面只读取当前聊天原文。帖子是剧情事件，页面结构由青鸟绘制。
import { ctx, getSettings, setSetting } from './settings.js?v=0.7.1';
import { maskExcluded, activeSwipe, activeSwipeKey } from './messages.js?v=0.7.1';
import { captureCurrentChat, currentChatMatches, isGenerationBusy, rebuildChatState } from './chat-store.js?v=0.7.1';
import { visibleStory } from './phone-memory.js?v=0.7.1';
import { requestBluebirdRaw } from './api.js?v=0.7.1';

export const SOCIAL_PLATFORMS = Object.freeze({ moments: '朋友圈', weibo: '微博', forum: '论坛', video: '视频' });
const KINDS = new Set(['post', 'comment', 'like', 'unlike']);
const ID = /^[\w.-]{1,80}$/;
const cached = new WeakMap();
const clip = (value, size) => String(value || '').trim().slice(0, size);

/** 从当前角色卡或群聊对应的设置里读好友名单；通讯录不等于微信好友。 */
export function socialFriends(context = ctx(), settings = getSettings()) {
    const owner = context.groupId != null && context.groupId !== '' ? `group:${context.groupId}`
        : `card:${context.characters?.[context.characterId]?.avatar || context.characterId}`;
    const list = settings.socialFriends?.[owner];
    return Array.isArray(list) ? [...new Set(list.filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean))] : [];
}

export function setSocialFriend(name, checked, context = ctx()) {
    const owner = context.groupId != null && context.groupId !== '' ? `group:${context.groupId}`
        : `card:${context.characters?.[context.characterId]?.avatar || context.characterId}`;
    const current = socialFriends(context).filter(item => item !== name);
    if (checked) current.push(name);
    setSetting('socialFriends', { ...getSettings().socialFriends, [owner]: current });
}

/** 仅接受每行一条 JSON；不执行模型返回的 HTML、脚本或 CSS。 */
export function parseSocialEvents(text, thinkTags = []) {
    text = typeof text === 'string' ? text : '';
    if (!/<bb-social\b/i.test(text)) return [];
    const masked = maskExcluded(text, thinkTags), result = [];
    for (const block of masked.matchAll(/<bb-social\b[^>]*>([\s\S]*?)<\/bb-social\s*>/gi)) {
        for (const line of block[1].split(/\r?\n/)) {
            let data;
            try { data = JSON.parse(line.trim()); } catch { continue; }
            if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.hasOwn(SOCIAL_PLATFORMS, data.platform)
                || !KINDS.has(data.kind) || !ID.test(data.id) || typeof data.author !== 'string' || !data.author.trim()) continue;
            const event = { platform: data.platform, kind: data.kind, id: data.id,
                author: clip(data.author, 80), text: clip(data.text, 1200), title: clip(data.title, 140),
                media: clip(data.media, 320), postId: typeof data.postId === 'string' ? data.postId : '' };
            if (event.kind === 'post' ? !event.text && !event.title : !ID.test(event.postId)) continue;
            if (event.kind === 'comment' && !event.text) continue;
            result.push(event);
        }
    }
    return result;
}

function floorEvents(floor, settings) {
    const key = JSON.stringify(settings.thinkTags), old = cached.get(floor);
    if (old?.text === floor.mes && old.key === key) return old.events;
    const events = parseSocialEvents(floor.mes, settings.thinkTags);
    cached.set(floor, { text: floor.mes, key, events });
    return events;
}

/** 朋友圈只读本人和已加好友的帖子及评论；公开平台不限通讯录。 */
export function socialState(context = ctx(), settings = getSettings(), type) {
    const posts = [], byId = new Map(), friends = new Set(socialFriends(context, settings).map(x => x.normalize('NFC')));
    const end = type === 'swipe' && context.chat.length && !context.chat.at(-1)?.is_user
        ? context.chat.length - 1 : context.chat.length;
    for (let floorIndex = 0; floorIndex < end; floorIndex++) {
        const floor = context.chat[floorIndex];
        if (!floor || typeof floor.mes !== 'string' || floor.is_system) continue;
        for (const event of floorEvents(floor, settings)) {
            const privateFeed = event.platform === 'moments';
            const visible = author => author === '我' || friends.has(author.normalize('NFC'));
            if (privateFeed && !visible(event.author)) continue;
            const key = `${event.platform}:${event.id}`;
            if (event.kind === 'post') {
                if (byId.has(key)) continue; // ID 必须指向唯一一条历史帖子。
                const post = { ...event, floorIndex, floorRef: floor, key, comments: [], likes: [], liked: false };
                byId.set(key, post); posts.push(post);
            } else {
                const post = byId.get(`${event.platform}:${event.postId}`);
                if (!post || (privateFeed && !visible(event.author))) continue;
                if (event.kind === 'comment') post.comments.push({ ...event, floorIndex });
                else {
                    post.likes = post.likes.filter(name => name !== event.author);
                    if (event.kind === 'like') post.likes.push(event.author);
                    post.liked = post.likes.includes('我');
                }
            }
        }
    }
    return { posts: posts.reverse(), friends: [...friends] };
}

const COMMON = `[青鸟·社交媒体] 青鸟显示的是用户手机可见的信息。只在剧情明确有人发布、用户打开相应页面浏览、或公开事件确需呈现讨论时，才生成社交事件；没有合适事件就完全不输出。每轮最多两条与当前情节有关的帖子及少量评论，不为凑热闹凭空制造关系、爆料或转折。
在正文自然叙述角色行动，末尾可用 <bb-social> 包住每行一个 JSON 对象，不生成 HTML、CSS 或代码框。只输出本轮已启用的平台；platform 必须使用对应的 moments、weibo、forum 或 video。帖子字段为 platform、kind:"post"、id、author、text，可选 title、media。评论字段为 platform、kind:"comment"、id、postId、author、text；点赞还可用 kind:"like"，必须有 postId。id 为每条事件独有的简短英文或数字标识，跨楼评论引用已有帖子的 id。只在确实发生时输出，不照抄示例。不要替用户点赞、评论或发帖。用户手机上已经发生的操作按下面的记录自然承接。`;
const RULES = {
    moments: '朋友圈是私密的好友圈。用户已加好友的人名：{friends}。只有这些人或用户本人所发动态可进入用户手机；评论和点赞也只呈现用户认识的好友，陌生人即便是发布者的好友也不可见。未加好友或只有青鸟通讯录记录的人不等于微信好友。没有好友就不要输出朋友圈事件。',
    weibo: '微博是公开平台。可生成任何账号的公开动态、热门话题及公开评论，包括非通讯录网友；区分官方、粉丝、路人等真实立场。私人消息不当作公开微博，角色看见微博不等于其他人也已看见。',
    forum: '论坛是公开的主题与楼层讨论。post 的 title 是帖子标题；comment 对应回帖，按剧情所需呈现，不把论坛回帖伪装成微博评论。',
    video: '视频页只对应确实已发布或正在观看的作品。post 写视频标题、简介和 media 封面画面描述；comment 写公开评论。直播弹幕和未发布私人片段不当作公开视频。',
};

export function socialRuleParts(settings, friends = []) {
    if (!settings.enabled || !settings.socialEnabled) return { common: '', platform: {} };
    const platform = {};
    for (const key of Object.keys(SOCIAL_PLATFORMS)) {
        if (!settings.socialPlatforms?.[key] || key === 'moments' && !friends.length) continue;
        platform[key] = RULES[key].replace('{friends}', () => friends.map(name => JSON.stringify(name)).join('、'));
    }
    return { common: Object.keys(platform).length ? COMMON : '', platform };
}

export function estimatedTokens(text) {
    const nonAscii = [...text].filter(c => c.charCodeAt(0) > 127).length;
    return Math.ceil(nonAscii * 1.1 + (text.length - nonAscii) / 3.5);
}

export function socialTokenEstimate(settings, friends = []) {
    const parts = socialRuleParts(settings, friends);
    const shared = estimatedTokens(parts.common);
    const platforms = Object.fromEntries(Object.keys(SOCIAL_PLATFORMS).map(key => [key, estimatedTokens(RULES[key].replace('{friends}', () => friends.map(name => JSON.stringify(name)).join('、')))]));
    return { shared, sharedPotential: estimatedTokens(COMMON), platforms, total: shared + Object.values(parts.platform).reduce((sum, text) => sum + estimatedTokens(text), 0) };
}

export function socialHistoryReminder(context, settings, type) {
    const enabled = Object.keys(socialRuleParts(settings, socialFriends(context, settings)).platform);
    if (!enabled.length) return '';
    const lines = [];
    const state = socialState(context, settings, type);
    for (const post of state.posts.filter(p => enabled.includes(p.platform)).slice(0, 7).reverse()) {
        lines.push(`${post.platform} ${JSON.stringify(post.id)} 第${post.floorIndex + 1}楼 ${post.author}：${post.title} ${post.text}`.slice(0, 320));
        for (const comment of post.comments.slice(-2)) lines.push(`评论 ${comment.author}：${comment.text}`.slice(0, 160));
    }
    return lines.length ? '[青鸟·已发生的社交动态]\n' + lines.join('\n').slice(-2200)
        + '\n只承接已经发生的内容；用户尚未操作时不要代其点赞或评论。' : '';
}

export function buildSocialPrompt(context, settings, type) {
    const parts = socialRuleParts(settings, socialFriends(context, settings));
    if (!parts.common) return '';
    const rules = [parts.common, ...Object.values(parts.platform)];
    const history = socialHistoryReminder(context, settings, type);
    if (history) rules.push(history);
    return rules.join('\n');
}

export function serializeSocialEvents(events) {
    return `<bb-social>\n${events.map(event => JSON.stringify(event).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')).join('\n')}\n</bb-social>`;
}

/** 手机操作和主动刷新落在当前有效楼层；保存失败仅撤销自己的写入。 */
let saveBusy = false;
export async function appendSocialEvents(events, owner = captureCurrentChat()) {
    if (saveBusy) throw new Error('上一条社交操作尚未保存，请稍后重试');
    if (!currentChatMatches(owner) || isGenerationBusy()) throw new Error('剧情正在生成或聊天已切换，请稍后再试');
    const context = ctx(), floor = context.chat.at(-1), settings = getSettings();
    if (!floor || !Array.isArray(events) || !events.length || typeof context.saveChat !== 'function') throw new Error('请先打开可保存的剧情');
    const valid = parseSocialEvents(serializeSocialEvents(events), settings.thinkTags);
    if (valid.length !== events.length) throw new Error('社交内容格式无效，未写入剧情');
    const old = floor.mes, variant = activeSwipeKey(floor), swipe = activeSwipe(floor);
    const next = `${old}\n${serializeSocialEvents(valid)}`;
    if (!currentChatMatches(owner) || floor !== context.chat.at(-1) || activeSwipeKey(floor) !== variant) throw new Error('楼层已改变，请重新操作');
    saveBusy = true;
    floor.mes = next;
    if (Array.isArray(floor.swipes) && typeof floor.swipes[swipe] === 'string') floor.swipes[swipe] = next;
    try { await context.saveChat(); }
    catch (error) {
        if (floor.mes === next && activeSwipeKey(floor) === variant) floor.mes = old;
        if (floor.swipes?.[swipe] === next) floor.swipes[swipe] = old;
        throw error;
    } finally { saveBusy = false; if (currentChatMatches(owner)) rebuildChatState('social'); }
    return valid;
}

let rawBusy = false;
export async function refreshSocial(platform) {
    const context = ctx(), settings = getSettings(), friends = socialFriends(context, settings);
    if (!settings.enabled || !settings.socialEnabled || !settings.socialPlatforms?.[platform]) throw new Error('先在设置里开启这个社交平台');
    if (platform === 'moments' && !friends.length) throw new Error('先在设置中勾选已加的朋友圈好友');
    if (rawBusy || isGenerationBusy()) throw new Error('正在生成剧情或页面，请稍后再试');
    const owner = captureCurrentChat(), history = socialHistoryReminder(context, settings, 'normal');
    const card = context.characters?.[context.characterId];
    const persona = [card?.name, card?.description || card?.data?.description,
        card?.personality || card?.data?.personality, card?.scenario || card?.data?.scenario].filter(Boolean).join('\n').slice(0, 1400);
    const prompt = `【人物与情境】\n${persona}\n【当前剧情】\n${visibleStory(context, settings).slice(-6500)}\n\n${history}\n\n用户主动打开${SOCIAL_PLATFORMS[platform]}刷新。只生成符合当前时间线和人物关系的新内容；没有合理新内容就输出空的 <bb-social></bb-social>。不要重复历史动态。`;
    const systemPrompt = [COMMON, RULES[platform].replace('{friends}', () => friends.map(name => JSON.stringify(name)).join('、')),
        `本次只能生成 ${platform} 的内容，最多两条新帖子及每帖两条评论。不能代用户行动。只输出 <bb-social>...</bb-social>。`].join('\n');
    rawBusy = true;
    try {
        const output = await requestBluebirdRaw(context, { prompt, systemPrompt, trimNames: false, responseLength: 1200 }, settings);
        if (!currentChatMatches(owner) || !getSettings().socialEnabled || !getSettings().socialPlatforms?.[platform]) throw new Error('聊天或设置已改变，已舍弃这次刷新');
        const body = String(output).match(/<bb-social\b[^>]*>([\s\S]*?)<\/bb-social\s*>/i);
        if (!body) throw new Error('社交刷新返回格式无效，请重试');
        const parsed = parseSocialEvents(output, settings.thinkTags);
        if (body[1].trim() && !parsed.length) throw new Error('社交刷新返回的 JSON 无效，请重试');
        if (parsed.some(event => event.platform !== platform)) throw new Error('社交刷新返回了其他平台内容，已舍弃');
        const events = parsed.slice(0, 8);
        if (platform === 'moments') {
            const allowed = new Set(['我', ...socialFriends(context, getSettings())]);
            if (events.some(e => !allowed.has(e.author))) throw new Error('返回内容含非好友的朋友圈记录，已舍弃本次刷新');
        }
        if (events.length) await appendSocialEvents(events, owner);
        return events.length;
    } finally { rawBusy = false; }
}

export async function actOnSocialPost(post, kind, text = '') {
    if (!['like', 'unlike', 'comment'].includes(kind)) throw new Error('不支持的互动');
    const settings = getSettings(), context = ctx();
    if (!settings.socialEnabled || !settings.socialPlatforms?.[post.platform]) throw new Error('这个平台已关闭');
    const current = socialState(context, settings).posts.find(item => item.key === post.key && item.floorRef === post.floorRef);
    if (!current) throw new Error('帖子已经改变，请重新打开');
    if (kind === 'comment' && (!text.trim() || text.length > 280)) throw new Error('评论请输入 1～280 字');
    if (kind === 'like' && current.liked || kind === 'unlike' && !current.liked) return [];
    const event = { platform: post.platform, kind, id: `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
        postId: current.id, author: '我', text: kind === 'comment' ? text.trim() : '' };
    return appendSocialEvents([event]);
}
