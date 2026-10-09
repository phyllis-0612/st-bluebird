// 第四段：后台手机回复和主线暂存快照，所有异步任务绑定原聊天。
import { ctx, getSettings, onSettingChanged } from './settings.js?v=0.6.8';
import { storyContacts, parseFloor, serializeFields, activeSwipeKey } from './messages.js?v=0.6.8';
import { getChatState, getPendingMessages, appendPendingMessages, captureCurrentChat, currentChatMatches, isGenerationBusy, landPendingMessages } from './chat-store.js?v=0.6.8';
import { buildPhoneRequest, phoneReplyLines } from './phone-memory.js?v=0.6.8';
import { selectedContacts } from './contacts.js?v=0.6.8';
import { requestBluebirdRaw } from './api.js?v=0.6.8';

export const PENDING_PROMPT_KEY = 'bluebird-pending';
const jobs = new Map(), phoneStatusListeners = new Set();
let initialized = false, epoch = 0, rawBusy = false, batch = null;
const normalTypes = [undefined, 'normal', 'regenerate', 'swipe'];
function notify() { for (const fn of phoneStatusListeners) fn(); }
export function onPhoneStatusChanged(fn) { phoneStatusListeners.add(fn); return () => phoneStatusListeners.delete(fn); }
export function getPhoneStatus(name) { return jobs.get(name) || { phase: 'idle' }; }
function clearPendingPrompt() { ctx().setExtensionPrompt?.(PENDING_PROMPT_KEY, '', 1, 0, false, 0); }
function invalidateReplies() {
    epoch++;
    for (const job of jobs.values()) {
        clearTimeout(job.timer);
        if (job.phase === 'typing' || job.phase === 'waiting') {
            job.phase = 'error'; job.error = '剧情已改变，消息已保留，点击重试回复';
        }
    }
    notify();
}
function validJob(job) { return jobs.get(job.name) === job && job.epoch === epoch && currentChatMatches(job.owner) && getSettings().enabled; }

export async function sendPhoneMessage(name, type, content, note = '') {
    if (!getSettings().enabled || !selectedContacts().some(c => c.name === name)) throw new Error('当前联系人不在通讯录中');
    if (isGenerationBusy()) throw new Error('请等这一轮剧情生成结束后再发手机消息');
    if (getPhoneStatus(name).phase === 'typing') throw new Error('请等这次手机回复结束后再发消息');
    const fields = ['我', type, String(content).trim()];
    if (['voice', 'transfer', 'location'].includes(type) && (note || type === 'transfer')) fields.push(String(note).trim());
    if (!parseFloor(`<bb-phone chat="验证">${serializeFields(fields)}</bb-phone>`).messages.length) throw new Error(type === 'transfer' ? '金额请填大于 0 的数字，最多两位小数' : '请填写消息内容');
    const owner = captureCurrentChat();
    await appendPendingMessages(name, [fields], owner);
    // 发送只保存到当前聊天的暂存区。用户明确点击「让对方回复」才请求 API。
    if (currentChatMatches(owner) && getPhoneStatus(name).phase === 'error') { jobs.delete(name); notify(); }
}

export function requestPhoneReply(name) {
    if (isGenerationBusy()) throw new Error('请等剧情生成结束后再请求手机回复');
    if (!selectedContacts().some(c => c.name === name)) throw new Error('当前联系人已不在通讯录中');
    const conversation = getChatState().conversations.find(c => c.name === name);
    if (!conversation?.messages.at(-1)?.pending || !conversation.messages.at(-1)?.isSelf) throw new Error('请先发送一条手机消息');
    if (['waiting', 'typing'].includes(getPhoneStatus(name).phase)) throw new Error('对方正在回复，请稍等');
    const previous = jobs.get(name); clearTimeout(previous?.timer);
    const job = { name, owner: captureCurrentChat(), epoch, phase: 'waiting', error: '', timer: null };
    jobs.set(name, job); notify();
    return runReply(job);
}

async function runReply(job) {
    if (!validJob(job)) return;
    if (rawBusy || isGenerationBusy()) { job.timer = setTimeout(() => runReply(job), 300); return; }
    rawBusy = true; job.phase = 'typing'; notify();
    const context = ctx();
    try {
        const conversation = getChatState().conversations.find(c => c.name === job.name);
        const settings = { ...getSettings() };
        const contact = selectedContacts(context, settings).find(c => c.name === job.name);
        if (!contact) throw new Error('联系人已从通讯录移除');
        const request = await buildPhoneRequest(context, contact, conversation, settings);
        if (!validJob(job) || isGenerationBusy()) return;
        const output = await requestBluebirdRaw(context, request, settings);
        if (!validJob(job) || isGenerationBusy()) return;
        const lines = phoneReplyLines(output, job.name, settings.thinkTags);
        await appendPendingMessages(job.name, lines.map(m => m.fields), job.owner, () => validJob(job));
        if (validJob(job)) { job.phase = 'idle'; job.error = ''; }
    } catch (error) {
        if (validJob(job)) { job.phase = 'error'; job.error = error.message || '回复失败，消息已保留，可以重试'; }
    } finally {
        rawBusy = false; notify();
    }
}

/** 生成拦截器调用时，用户楼层已入楼，regenerate 的旧回复也已移除。 */
export function preparePendingGeneration(type) {
    clearPendingPrompt(); batch = null;
    if (!normalTypes.includes(type) || !getSettings().enabled) return;
    const context = ctx(), records = getPendingMessages().filter(r => Array.isArray(r?.fields) && typeof r.chatName === 'string' && typeof r.id === 'string');
    if (!records.length) return;
    invalidateReplies();
    const newIndex = type === 'swipe' && !context.chat.at(-1)?.is_user ? context.chat.length - 1 : context.chat.length;
    const floor = context.chat[newIndex - 1];
    if (!floor) return;
    batch = { owner: captureCurrentChat(), floor, text: floor.mes, variant: activeSwipeKey(floor), records: records.map(r => ({ ...r, fields: [...r.fields] })), newIndex, stopped: false, received: false };
    const prompt = `[青鸟·已发生的手机聊天]\n上一段剧情之后，${context.name1 || '用户'}在手机上聊了以下内容。把这些当作已经发生的事，自然接续剧情；不要重新发送或重复这些消息，不替不知情的人补记忆。\n`
        + batch.records.map(r => `${JSON.stringify(r.chatName)}：${serializeFields(r.fields)}`).join('\n');
    const owner = batch.owner;
    context.setExtensionPrompt?.(PENDING_PROMPT_KEY, prompt, 1, 0, false, 0, () => getSettings().enabled && currentChatMatches(owner));
}

async function finishPendingGeneration() {
    const current = batch; clearPendingPrompt();
    if (!current || !current.received || !current.ended) return;
    batch = null;
    if (current.stopped || !currentChatMatches(current.owner)) return;
    try {
        const ok = await landPendingMessages(current, current.newIndex);
        if (!ok && currentChatMatches(current.owner)) toastr.info('手机聊天仍在暂存区，会在下一次成功生成时落楼');
    } catch (error) { if (currentChatMatches(current.owner)) toastr.error('手机聊天落楼保存失败，暂存仍保留：' + error.message); }
}

export function initPhoneChat() {
    if (initialized) return; initialized = true;
    const context = ctx(), events = context.eventTypes || context.event_types || {};
    const on = (key, fn) => { if (events[key]) context.eventSource.on(events[key], fn); };
    clearPendingPrompt();
    on('GENERATION_STARTED', (_type, _options, dryRun) => {
        if (!dryRun) { batch = null; clearPendingPrompt(); invalidateReplies(); }
    });
    on('MESSAGE_RECEIVED', (index, type) => {
        const processor = ctx().streamingProcessor;
        if (processor?.messageId === index && (processor.isStopped || processor.abortController?.signal.aborted)) return;
        if (batch && normalTypes.includes(type) && index === batch.newIndex && currentChatMatches(batch.owner)
            && !ctx().chat[index]?.is_user && !ctx().chat[index]?.is_system && ctx().chat[index]?.mes?.trim()
            && ctx().chat[index].mes.trim() !== '...') {
            batch.received = true;
            if (batch.ended) setTimeout(finishPendingGeneration, 0);
        }
    });
    // ENDED 只表示停止按钮隐藏，流式失败也会触发。稍后检查成功的 MESSAGE_RECEIVED。
    on('GENERATION_ENDED', () => {
        const current = batch;
        if (current) current.ended = true;
        setTimeout(() => { if (current && batch === current) finishPendingGeneration(); }, 0);
    });
    on('GENERATION_STOPPED', () => { if (batch) batch.stopped = true; clearPendingPrompt(); invalidateReplies(); });
    on('CHAT_CHANGED', () => { batch = null; clearPendingPrompt(); invalidateReplies(); jobs.clear(); notify(); });
    for (const key of ['MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED']) on(key, () => { invalidateReplies(); batch = null; clearPendingPrompt(); });
    onSettingChanged(key => { if (key === 'enabled' && !getSettings().enabled) { batch = null; clearPendingPrompt(); invalidateReplies(); } });
}
