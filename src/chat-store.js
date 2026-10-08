// 当前聊天的状态与安全写回。楼层原文是消息的唯一来源。
import { ctx, getSettings } from './settings.js?v=0.6.3';
import { activeSwipe, activeSwipeKey, buildState, parseFloor, replaceTransferLine, storyContacts, escapeAttribute, serializeFields } from './messages.js?v=0.6.3';
import { selectedContacts } from './contacts.js?v=0.6.3';

let state = buildState([]);
let owner = null;
let identitySaveTimer = null;
let generationActive = false;
let generationStartedAt = 0;
let writing = false;
const listeners = new Set();

function chatKey(context) {
    const group = context.groupId !== undefined && context.groupId !== null && context.groupId !== '';
    return JSON.stringify([context.groupId ?? null, group ? null : context.characters?.[context.characterId]?.avatar ?? context.characterId ?? null,
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
    if (!Array.isArray(data.pending)) data.pending = [];
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
        if (!parseFloor(floor.mes, { thinkTags, viewer: context.name1 || '我' }).messages.length) continue;
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
    state = buildState(chat, { thinkTags, viewer: context.name1 || '我', lastSeen: context.chatMetadata?.bluebird?.lastSeen || {} });
    const data = metadata(context);
    for (const { name } of selectedContacts(context)) {
        const id = `name:${name.normalize('NFC')}`;
        if (!state.conversations.some(c => c.id === id)) state.conversations.push({ id, name, members: [name], messages: [], unread: 0 });
    }
    for (const record of data?.pending || []) {
        if (!record || typeof record.id !== 'string' || !Array.isArray(record.fields) || typeof record.chatName !== 'string') continue;
        const parsed = parseFloor(`<bb-phone source="phone" chat="${escapeAttribute(record.chatName)}">\n${serializeFields(record.fields)}\n</bb-phone>`, { thinkTags }).messages[0];
        if (!parsed) continue;
        const id = `name:${record.chatName.normalize('NFC')}`;
        let conversation = state.conversations.find(c => c.id === id);
        if (!conversation) { conversation = { id, name: record.chatName, members: [record.chatName], messages: [], unread: 0 }; state.conversations.push(conversation); }
        const message = { ...parsed, id: record.id, conversationId: id, pending: true, floorIndex: null, order: state.byId.size,
            unread: !parsed.isSelf && !(data.lastSeen[id] || []).includes(record.id) };
        conversation.messages.push(message); conversation.unread += Number(message.unread);
        state.unread += Number(message.unread); state.byId.set(record.id, message);
    }
    state.conversations.sort((a, b) => (b.messages.at(-1)?.order ?? -1) - (a.messages.at(-1)?.order ?? -1));
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
    if (target?.pending) {
        const record = metadata(context).pending.find(r => r.id === messageId);
        if (!record || target.type !== 'transfer' || target.isSelf || target.status || !['accepted', 'returned'].includes(status)) throw new Error('这笔转账已经处理，或不支持此操作');
        const fields = [...record.fields]; while (fields.length < 4) fields.push(''); fields[4] = status;
        const before = record.fields; record.fields = fields; writing = true;
        try { await context.saveChat(); if (matches(saved)) rebuildChatState('transfer'); }
        catch (error) { if (record.fields === fields) record.fields = before; if (matches(saved)) rebuildChatState('transfer'); throw error; }
        finally { writing = false; }
        return;
    }
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

export function getPendingMessages() { return metadata()?.pending || []; }

export async function appendPendingMessages(chatName, fieldsList, saved = capture(), guard = () => true) {
    if (!matches(saved) || !guard()) throw new Error('聊天已改变，本次回复已停止');
    if (writing) throw new Error('正在保存，请稍等后重试');
    const context = ctx(), data = metadata(context);
    if (!data || typeof context.saveChat !== 'function') throw new Error('请先打开一个可保存的角色聊天');
    const records = fieldsList.map(fields => ({ id: `pending:${newId()}`, chatName, fields: [...fields], createdAt: Date.now() }));
    const ids = new Set(records.map(r => r.id));
    data.pending.push(...records); writing = true;
    try { await context.saveChat(); }
    catch (error) { data.pending = data.pending.filter(r => !ids.has(r.id)); throw error; }
    finally { writing = false; if (matches(saved)) rebuildChatState('pending'); }
    return records;
}

/** 同一份存档里同时写入文本并移除快照；后来发的消息继续留在暂存区。 */
export async function landPendingMessages(batch, newFloorIndex) {
    if (!batch || !matches(batch.owner) || writing) return false;
    const context = ctx(), target = batch.floor;
    if (context.chat[newFloorIndex - 1] !== target || context.chat[newFloorIndex]?.is_user
        || activeSwipeKey(target) !== batch.variant || target.mes !== batch.text) return false;
    const data = metadata(context), ids = new Set(batch.records.map(r => r.id));
    const records = data.pending.filter(r => ids.has(r.id));
    if (!records.length) return false;
    const groups = [];
    for (const record of records) {
        let group = groups.at(-1);
        if (group?.name !== record.chatName) { group = { name: record.chatName, records: [] }; groups.push(group); }
        group.records.push(record);
    }
    const blocks = groups.map(g => `<bb-phone source="phone" chat="${escapeAttribute(g.name)}">\n${g.records.map(r => serializeFields(r.fields)).join('\n')}\n</bb-phone>`).join('\n');
    const swipe = activeSwipe(target), info = target.swipe_info?.[swipe];
    const before = { text: target.mes, swipe: target.swipes?.[swipe], pending: data.pending, seen: data.lastSeen,
        display: target.extra?.display_text, infoDisplay: info?.extra?.display_text };
    const after = `${target.mes}\n${blocks}`;
    target.mes = after;
    if (Array.isArray(target.swipes)) target.swipes[swipe] = after;
    if (target.extra) delete target.extra.display_text;
    if (info?.extra) delete info.extra.display_text;
    data.pending = data.pending.filter(r => !ids.has(r.id)); writing = true;
    // 将暂存消息已读状态迁到落楼后的身份，避免凭空变成未读。
    rebuildChatState('landing');
    const added = state.floors.get(newFloorIndex - 1)?.filter(m => m.start >= before.text.length) || [];
    data.lastSeen = { ...before.seen };
    added.forEach((m, i) => { const old = records[i]; if (old && (before.seen[m.conversationId] || []).includes(old.id)) {
        data.lastSeen[m.conversationId] = [...(data.lastSeen[m.conversationId] || []), m.id];
    } });
    try {
        await context.saveChat();
    } catch (error) {
        if (target.mes === after) target.mes = before.text;
        if (target.swipes?.[swipe] === after) target.swipes[swipe] = before.swipe;
        data.pending = before.pending; data.lastSeen = before.seen;
        if (target.extra && before.display !== undefined) target.extra.display_text = before.display;
        if (info?.extra && before.infoDisplay !== undefined) info.extra.display_text = before.infoDisplay;
        if (matches(batch.owner)) rebuildChatState('landing-failed');
        throw error;
    } finally { writing = false; }
    if (matches(batch.owner)) {
        try { context.updateMessageBlock?.(newFloorIndex - 1, target); }
        catch (error) { console.error('[青鸟] 手机聊天已保存，楼层显示刷新失败', error); }
        rebuildChatState('landed');
    }
    return true;
}
