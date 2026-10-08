// 标签隐藏发生在显示管线；提醒在渲染完成后用安全 DOM 添加。
import { ctx, getSettings, onSettingChanged } from './settings.js?v=0.6.4';
import { hidePhoneTags } from './messages.js?v=0.6.4';
import { getChatState, rebuildChatState, setGenerationActive, onChatStateChanged, captureCurrentChat, currentChatMatches } from './chat-store.js?v=0.6.4';

const RULES = [
    { id: '374d0d58-fd6a-4a2d-a798-51c67b9aa001', scriptName: '青鸟 · 隐藏手机消息（显示）',
        findRegex: '/<bb-phone\\b[^>]*>[\\s\\S]*?(?:<\\/bb-phone\\s*>|$)/gi', markdownOnly: true, promptOnly: false },
    { id: '374d0d58-fd6a-4a2d-a798-51c67b9aa002', scriptName: '青鸟 · 隐藏在场名单（显示）',
        findRegex: '/<bb-present\\b[^>]*>[\\s\\S]*?(?:<\\/bb-present\\s*>|$)/gi', markdownOnly: true, promptOnly: false },
    { id: '374d0d58-fd6a-4a2d-a798-51c67b9aa003', scriptName: '青鸟 · 移除在场名单（提示词）',
        findRegex: '/<bb-present\\b[^>]*>[\\s\\S]*?<\\/bb-present\\s*>/gi', markdownOnly: false, promptOnly: true },
];
let installed = false, hookInstalled = false;
let scheduled = null, noticeFrame = null;
let openConversation = null;
let chatObserver = null, hostObserver = null, observedChat = null;

export function syncRegexRules() {
    const context = ctx(), settings = context.extensionSettings;
    if (!Array.isArray(settings.regex)) settings.regex = [];
    let changed = false;
    for (const definition of RULES) {
        const next = { ...definition, replaceString: '', trimStrings: [], placement: [1, 2],
            disabled: !getSettings().enabled, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null };
        const existing = settings.regex.find(rule => rule.id === next.id);
        if (!existing) { settings.regex.push(next); changed = true; }
        else if (Object.entries(next).some(([key, value]) => JSON.stringify(existing[key]) !== JSON.stringify(value))) {
            Object.assign(existing, next); changed = true;
        }
    }
    if (changed) context.saveSettingsDebounced();
}

function installFormatterHook() {
    const formatter = ctx().messageFormatter;
    if (hookInstalled || typeof formatter?.addHook !== 'function') return;
    formatter.addHook(text => getSettings().enabled ? hidePhoneTags(text) : text,
        { stage: formatter.stage?.BEFORE_REGEX || 'beforeRegex', order: 0 });
    hookInstalled = true;
}

function scheduleRefresh() {
    if (scheduled !== null) return;
    scheduled = setTimeout(() => { scheduled = null; rebuildChatState(); }, 80);
}

function scheduleNotices() {
    if (noticeFrame !== null) return;
    noticeFrame = requestAnimationFrame(() => { noticeFrame = null; refreshFloorNotices(); });
}

export function refreshFloorNotices() {
    const settings = getSettings(), state = getChatState();
    for (const floorNode of document.querySelectorAll('#chat .mes[mesid]')) {
        const floorIndex = Number(floorNode.getAttribute('mesid'));
        const host = floorNode.querySelector('.mes_text');
        if (!host) continue;
        const previous = [...host.children].find(node => node.classList.contains('bb-floor-notices'));
        const incoming = settings.enabled && settings.inlineNotice
            ? (state.floors.get(floorIndex) || []).filter(message => !message.isSelf) : [];
        const groups = new Map();
        for (const message of incoming) {
            const group = groups.get(message.conversationId) || { name: message.chatName, count: 0 };
            group.count++; groups.set(message.conversationId, group);
        }
        const signature = JSON.stringify([...groups]);
        if (previous?.dataset.bbSignature === signature) continue;
        previous?.remove();
        if (!groups.size) continue;
        const wrap = document.createElement('div');
        wrap.className = 'bb-floor-notices'; wrap.dataset.bbSignature = signature;
        for (const [id, { name, count }] of groups) {
            const button = document.createElement('button');
            button.type = 'button'; button.className = 'bb-inline-notice';
            button.textContent = `${name}发来 ${count} 条消息`;
            button.addEventListener('click', event => {
                event.preventDefault(); event.stopPropagation();
                openConversation?.(id);
            });
            wrap.appendChild(button);
        }
        host.appendChild(wrap);
    }
}

/** 更新安装前已渲染的标签；只重画当前 DOM 已加载的相关楼层。 */
export function reformatTaggedFloors() {
    const context = ctx();
    if (typeof context.updateMessageBlock !== 'function') return;
    for (const node of document.querySelectorAll('#chat .mes[mesid]')) {
        const index = Number(node.getAttribute('mesid')), floor = context.chat?.[index];
        if (floor && /<bb-(?:phone|present)\b/i.test(floor.mes)) context.updateMessageBlock(index, floor);
    }
    scheduleNotices();
}

function bindChatDOM() {
    const chat = document.getElementById('chat');
    if (chat && chat !== observedChat) {
        chatObserver?.disconnect(); observedChat = chat;
        chatObserver = new MutationObserver(records => {
            // 本插件写入提醒不触发全聊天重建。
            if (records.every(record => record.target.closest?.('.bb-floor-notices')
                || (record.type === 'childList' && record.addedNodes.length + record.removedNodes.length > 0
                    && [...record.addedNodes, ...record.removedNodes].every(node => node.nodeType === 1 && node.classList?.contains('bb-floor-notices'))))) return;
            scheduleRefresh();
        });
        chatObserver.observe(chat, { childList: true, subtree: true, characterData: true });
        hostObserver?.disconnect(); hostObserver = null;
        reformatTaggedFloors();
    } else if (!chat && !hostObserver) {
        hostObserver = new MutationObserver(bindChatDOM);
        hostObserver.observe(document.body, { childList: true, subtree: true });
    }
}

export function initChatIntegration(onOpenConversation) {
    openConversation = onOpenConversation;
    if (installed) return;
    installed = true;
    syncRegexRules(); installFormatterHook();
    onChatStateChanged(scheduleNotices);
    onSettingChanged(key => {
        if (key === 'enabled') { syncRegexRules(); reformatTaggedFloors(); }
        if (key === 'thinkTags') rebuildChatState();
        if (key === 'inlineNotice' || key === 'enabled') scheduleNotices();
    });
    const context = ctx(), events = context.eventTypes || context.event_types || {};
    const on = (name, handler) => { if (events[name]) context.eventSource?.on(events[name], handler); };
    on('CHAT_CHANGED', () => { rebuildChatState('chat'); bindChatDOM(); reformatTaggedFloors(); });
    for (const name of ['CHAT_LOADED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED',
        'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MORE_MESSAGES_LOADED']) on(name, scheduleRefresh);
    for (const name of ['USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED']) on(name, scheduleRefresh);
    on('GENERATION_STARTED', (type, options = {}, dryRun = false) => {
        // 提示词/Token 预演也会发开始事件，通常不会发结束事件。
        // 后台 quiet 回复不修改正文楼层，不建立正文写回锁。
        if (dryRun || (type === 'quiet' && !options?.quietToLoud)) return;
        setGenerationActive(true);
    });
    for (const name of ['GENERATION_ENDED', 'GENERATION_STOPPED']) on(name, () => { setGenerationActive(false); scheduleRefresh(); });
    for (const name of ['APP_READY', 'APP_INITIALIZED']) on(name, () => {
        installFormatterHook(); bindChatDOM(); rebuildChatState(); reformatTaggedFloors();
    });
    rebuildChatState(); bindChatDOM();
}

export async function scrollToFloor(message) {
    const context = ctx(), saved = captureCurrentChat();
    const index = context.chat?.indexOf(message.floorRef);
    if (!(index >= 0)) throw new Error('这条消息所在的楼层已经删除');
    let node = document.querySelector(`#chat .mes[mesid="${index}"]`);
    // 通过酒馆自己的「展开历史」按钮补载，不修改隐藏标记或保留窗口。
    for (let attempts = 0; !node && attempts < 200; attempts++) {
        const more = document.getElementById('show_more_messages');
        if (!more) break;
        const firstBefore = document.querySelector('#chat .mes[mesid]')?.getAttribute('mesid');
        more.click();
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (!currentChatMatches(saved)) throw new Error('聊天已切换，请重新打开消息');
        node = document.querySelector(`#chat .mes[mesid="${index}"]`);
        if (!node && document.querySelector('#chat .mes[mesid]')?.getAttribute('mesid') === firstBefore) break;
    }
    scheduleNotices();
    if (!node) throw new Error('暂时找不到这一楼，请在酒馆展开历史消息后再试');
    node.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    node.classList.add('bb-floor-highlight');
    setTimeout(() => node.classList.remove('bb-floor-highlight'), 1500);
}
