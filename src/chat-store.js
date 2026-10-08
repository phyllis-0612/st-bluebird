// 当前聊天的状态与安全写回。楼层原文是消息的唯一来源。
import { ctx, getSettings } from './settings.js?v=0.3.0';
import { activeSwipe, buildState, parseFloor, replaceTransferLine } from './messages.js?v=0.3.0';

let state = buildState([]);
let owner = null;
let identitySaveTimer = null;
let generationActive = false;
let generationStartedAt = 0;
let writing = false;
const listeners = new Set();

function chatKey(context) {
    return JSON.stringify([context.groupId ?? null, context.characters?.[context.characterId]?.avatar ?? context.characterId ?? null,
        context.chatId ?? context.getCurrentChatId?.() ?? null]);
}

function capture(context = ctx()) {
    return { key: chatKey(context), chat: context.chat, metadata: context.chatMetadata };
}

function matches(saved, context = ctx()) {
    return saved && saved.key === chatKey(context) && saved.chat === context.chat && saved.metadata === context.chatMetadata;
}

function metadata(context = ctx()) {
    const meta = context.chatMetadata;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    if (!meta.bluebird || typeof meta.bluebird !== 'object' || Array.isArray(meta.bluebird)) meta.bluebird = {};
    const data = meta.bluebird;
    if (!data.lastSeen || typeof data.lastSeen !== 'object' || Array.isArray(data.lastSeen)) data.lastSeen = {};
    data.version = 1;
    return data;
}

function emit(reason) { for (const listener of listeners) listener(state, reason); }

export function onChatStateChanged(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getChatState() { return state; }
export function setGenerationActive(value) {
    generationActive = Boolean(value);
    generationStartedAt = generationActive ? Date.now() : 0;
}

/** 开始事件可能没有对应结束事件；实际忙碌以酒馆当前控件状态为准。 */
export function isGenerationBusy() {
    const doc = globalThis.document;
    const flag = doc?.body?.dataset?.generating;
    const stop = doc?.getElementById?.('mes_stop');
    const style = stop && (typeof globalThis.getComputedStyle === 'function' ? getComputedStyle(stop) : stop.style);
    if (flag === 'true' || (stop && !stop.hidden && style?.display && style.display !== 'none')) return true;
    if (stop || flag === 'false') {
        // 真正生成刚开始时，停止按钮还没显示。短暂保护请求准备阶段。
        if (generationActive && Date.now() - generationStartedAt < 1500) return true;
        setGenerationActive(false);
        return false;
    }
    // 无标准酒馆控件的环境，保留事件保护。
    return generationActive;
}

function newId() {
    return globalThis.crypto?.randomUUID?.() || `bb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function saveFloorIdentities(saved) {
    clearTimeout(identitySaveTimer);
    identitySaveTimer = setTimeout(async () => {
        identitySaveTimer = null;
        if (!matches(saved)) return;
        // 不在流式生成中保存半成品；结束事件会重新安排。
        if (isGenerationBusy() || writing) { saveFloorIdentities(saved); return; }
        try { await ctx().saveChat?.(); }
        catch (error) { console.error('[青鸟] 保存消息标识失败', error); }
    }, 600);
}

export function rebuildChatState(reason = 'update') {
    const context = ctx();
    const saved = capture(context);
    const changed = !matches(owner, context);
    if (changed) { clearTimeout(identitySaveTimer); identitySaveTimer = null; generationActive = false; }
    owner = saved;
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const thinkTags = getSettings().thinkTags;
    let newIdentities = false;
    const usedIds = new Set();
    for (const floor of chat) {
        if (!floor || typeof floor.mes !== 'string' || !/<bb-phone\b/i.test(floor.mes)) continue;
        if (!parseFloor(floor.mes, { thinkTags }).messages.length) continue;
        if (!floor.extra || typeof floor.extra !== 'object' || Array.isArray(floor.extra)) floor.extra = {};
        if (!floor.extra.bluebird || typeof floor.extra.bluebird !== 'object' || Array.isArray(floor.extra.bluebird)) floor.extra.bluebird = {};
        if (Array.isArray(floor.swipes)) {
            if (!Array.isArray(floor.swipe_info)) { floor.swipe_info = []; newIdentities = true; }
            for (let index = 0; index < floor.swipes.length; index++) {
                if (typeof floor.swipes[index] !== 'string' || (floor.swipe_info[index] && typeof floor.swipe_info[index] === 'object')) continue;
                floor.swipe_info[index] = { send_date: floor.send_date,
                    extra: index === activeSwipe(floor) ? { ...floor.extra, bluebird: { ...floor.extra.bluebird } } : {} };
                newIdentities = true;
            }
        }
        const fromOtherSwipe = Array.isArray(floor.swipe_info)
            ? floor.swipe_info.find(info => typeof info?.extra?.bluebird?.floorId === 'string')?.extra.bluebird.floorId : null;
        let floorId = floor.extra.bluebird.floorId || fromOtherSwipe;
        if (typeof floorId !== 'string' || !floorId || usedIds.has(floorId)) floorId = newId();
        if (floor.extra.bluebird.floorId !== floorId) { floor.extra.bluebird.floorId = floorId; newIdentities = true; }
        usedIds.add(floorId);
        // 酒馆切 swipe 会替换整个 extra。各版本共用楼层 ID，但分别保存稳定版本 ID。
        const variants = new Set();
        if (Array.isArray(floor.swipe_info)) for (const info of floor.swipe_info) {
            if (!info || typeof info !== 'object') continue;
            if (!info.extra || typeof info.extra !== 'object' || Array.isArray(info.extra)) info.extra = {};
            if (!info.extra.bluebird || typeof info.extra.bluebird !== 'object' || Array.isArray(info.extra.bluebird)) info.extra.bluebird = {};
            if (info.extra.bluebird.floorId !== floorId) { info.extra.bluebird.floorId = floorId; newIdentities = true; }
            let id = info.extra.bluebird.swipeId;
            if (typeof id !== 'string' || !id || variants.has(id)) { id = newId(); info.extra.bluebird.swipeId = id; newIdentities = true; }
            variants.add(id);
        }
        const activeInfoId = floor.swipe_info?.[activeSwipe(floor)]?.extra?.bluebird?.swipeId;
        const swipeId = activeInfoId || (typeof floor.extra.bluebird.swipeId === 'string' && floor.extra.bluebird.swipeId) || newId();
        if (floor.extra.bluebird.swipeId !== swipeId) { floor.extra.bluebird.swipeId = swipeId; newIdentities = true; }
    }
    state = buildState(chat, { thinkTags, lastSeen: context.chatMetadata?.bluebird?.lastSeen || {} });
    if (newIdentities) saveFloorIdentities(saved);
    emit(changed ? 'chat' : reason);
    return state;
}

export function markConversationRead(conversationId) {
    if (!matches(owner)) return;
    const conversation = state.conversations.find(c => c.id === conversationId);
    if (!conversation?.unread) return;
    const context = ctx(), data = metadata(context);
    if (!data) return;
    const seen = new Set(Array.isArray(data.lastSeen[conversationId]) ? data.lastSeen[conversationId] : []);
    for (const message of conversation.messages) if (!message.isSelf) seen.add(message.id);
    data.lastSeen[conversationId] = [...seen];
    // 保存楼层 ID 和已读位置为同一份聊天，避免刷新后 ID 与已读不匹配。
    saveFloorIdentities(capture(context));
    for (const message of conversation.messages) message.unread = false;
    state.unread -= conversation.unread; conversation.unread = 0;
    emit('read');
}

export async function processTransfer(messageId, status) {
    if (writing) throw new Error('正在保存，请稍等');
    if (!matches(owner)) { rebuildChatState(); throw new Error('聊天已切换，请重新打开转账'); }
    if (isGenerationBusy()) throw new Error('请等这一轮剧情生成结束后再处理转账');
    rebuildChatState('before-write');
    const context = ctx(), saved = capture(context);
    const target = state.byId.get(messageId);
    if (!target || !context.chat.includes(target.floorRef)) throw new Error('这条消息已不存在');
    if (typeof context.saveChat !== 'function') throw new Error('当前酒馆缺少保存聊天接口');
    const floor = target.floorRef;
    const info = floor.swipe_info?.[target.swipe];
    const before = { mes: floor.mes, swipe: floor.swipes?.[target.swipe], displayText: floor.extra?.display_text,
        infoDisplayText: info?.extra?.display_text };
    let afterWrite = null;
    let savedSuccessfully = false;
    writing = true;
    try {
        afterWrite = replaceTransferLine(floor, target, status);
        // 旧显示缓存可能属于修改前的文本，只让酒馆重算，不写入自定义 HTML。
        if (floor.extra) delete floor.extra.display_text;
        if (info?.extra) delete info.extra.display_text;
        await context.saveChat();
        savedSuccessfully = true;
        if (matches(saved)) {
            const floorIndex = context.chat.indexOf(floor);
            try { context.updateMessageBlock?.(floorIndex, floor); }
            catch (error) { console.error('[青鸟] 楼层刷新失败', error); }
            rebuildChatState('transfer');
        }
    } catch (error) {
        // 只撤销我们自己的写入，不能覆盖保存期间用户的编辑或 swipe。
        if (!savedSuccessfully && afterWrite !== null) {
            if (Array.isArray(floor.swipes) && floor.swipes[target.swipe] === afterWrite) floor.swipes[target.swipe] = before.swipe;
            if (before.infoDisplayText !== undefined && info?.extra && info.extra.display_text === undefined) info.extra.display_text = before.infoDisplayText;
            if (floor.mes === afterWrite && activeSwipe(floor) === target.swipe) {
                floor.mes = before.mes;
                if (before.displayText !== undefined && floor.extra) floor.extra.display_text = before.displayText;
            }
            if (matches(saved)) {
                context.updateMessageBlock?.(context.chat.indexOf(floor), floor);
                rebuildChatState('transfer');
            }
        }
        throw error;
    } finally { writing = false; }
}

export function currentChatMatches(saved) { return matches(saved); }
export function captureCurrentChat() { return capture(); }
