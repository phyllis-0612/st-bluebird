// 青鸟 · 手机面板
// 手机端全屏面板。
// 第四段：手机消息、主动输入和暂存状态。

import { icons } from './icons.js?v=0.4.0';
import { ctx, getSettings, setSetting, applyThemeEverywhere, VERSION } from './settings.js?v=0.4.0';
import { createEntryModeControl } from './entry-controls.js?v=0.4.0';
import { getChatState, rebuildChatState, markConversationRead, processTransfer } from './chat-store.js?v=0.4.0';
import { scrollToFloor } from './chat-integration.js?v=0.4.0';
import { fingerprint } from './messages.js?v=0.4.0';
import { sendPhoneMessage, retryPhoneReply, getPhoneStatus } from './phone-chat.js?v=0.4.0';
import { captureCurrentChat, currentChatMatches, isGenerationBusy } from './chat-store.js?v=0.4.0';
import { getStoryContacts } from './proactive.js?v=0.4.0';

let root = null;
let page = 'list';
let isOpen = false;
let returnFocus = null;
const backgroundNodes = new Map();
let backgroundObserver = null;
let conversationId = null;
let transferPending = false;
const expandedVoiceIds = new Set();
const drafts = new Map();
let attachmentType = null;
let sending = false;
function currentDraft() {
    if (!drafts.has(conversationId)) drafts.set(conversationId, { text: '', content: '', note: '' });
    return drafts.get(conversationId);
}

/** 全屏时隔离背后的酒馆控件，关闭时恢复原来的 inert 状态。 */
function lockBackground() {
    const lock = (node) => {
        if (!(node instanceof HTMLElement) || node === root || backgroundNodes.has(node)) return;
        backgroundNodes.set(node, node.inert);
        node.inert = true;
    };
    for (const node of document.body.children) lock(node);
    backgroundObserver = new MutationObserver((records) => {
        for (const record of records) {
            for (const node of record.addedNodes) lock(node);
        }
    });
    backgroundObserver.observe(document.body, { childList: true });
}

function unlockBackground() {
    backgroundObserver?.disconnect();
    backgroundObserver = null;
    for (const [node, inert] of backgroundNodes) node.inert = inert;
    backgroundNodes.clear();
}

function focusableControls() {
    return [...root.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
        .filter((node) => !node.disabled && node.tabIndex >= 0
            && !node.closest('[hidden], [inert]') && node.getClientRects().length > 0);
}

// ---------- 小工具 ----------

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

/** 当前剧情名：角色卡名或群聊名。用 textContent 写入，不拼 HTML。 */
function storyLabel() {
    const c = ctx();
    if (c.groupId) {
        const group = (c.groups || []).find((g) => g.id === c.groupId);
        return group ? `当前剧情《${group.name}》` : '当前是群聊';
    }
    const character = c.characters?.[c.characterId];
    return character ? `当前剧情《${character.name}》` : '还没打开聊天';
}

// ---------- 页面 ----------

function emptyState(title, text) {
    const wrap = el('div', 'bb-empty');
    wrap.append(el('p', 'bb-empty-title', title), el('p', 'bb-empty-text', text));
    return wrap;
}

function renderList() {
    const state = getChatState();
    if (!state.conversations.length) return emptyState('还没有消息', '联系人不在你身边、有合适时机时，会随剧情发来手机消息。可以从通讯录打开联系人，主动给她发消息。');
    const list = el('div', 'bb-conversations');
    list.append(el('p', 'bb-section-caption', '剧情之外，也有牵挂'));
    for (const conversation of state.conversations) {
        const button = el('button', 'bb-conversation'); button.type = 'button';
        button.dataset.bbConversation = conversation.id;
        const avatar = el('span', 'bb-avatar', [...conversation.name][0] || '鸟');
        avatar.setAttribute('aria-hidden', 'true');
        const content = el('span', 'bb-conversation-copy');
        const title = el('span', 'bb-conversation-title', conversation.name);
        const last = conversation.messages.at(-1);
        content.append(title, el('span', 'bb-conversation-preview', last ? `${last.isSelf ? '我：' : ''}${messagePreview(last)}` : '点开开始聊天'));
        const meta = el('span', 'bb-conversation-meta');
        meta.append(el('span', 'bb-floor-label', last?.pending ? '暂存' : last ? `第 ${last.floorIndex + 1} 楼` : '联系人'));
        if (conversation.unread) meta.append(el('span', 'bb-unread-pill', conversation.unread > 99 ? '99+' : String(conversation.unread)));
        button.append(avatar, content, meta); list.append(button);
    }
    return list;
}

function messagePreview(message) {
    if (message.type === 'transfer') return `[转账] ¥${message.content}${message.note ? ' · ' + message.note : ''}`;
    if (message.type === 'voice') return getSettings().voiceEnabled ? '[语音消息]' : message.content;
    if (message.type === 'image') return `[图片] ${message.content}`;
    if (message.type === 'location') return `[位置] ${message.content}`;
    return message.content;
}

function cardIcon(type) {
    const span = el('span', 'bb-card-icon');
    span.innerHTML = type === 'voice' ? icons.voice(22) : type === 'image' ? icons.image(24)
        : type === 'location' ? icons.location(24) : icons.transfer(24);
    return span;
}

function renderMessage(message) {
    const row = el('article', 'bb-message' + (message.isSelf ? ' is-self' : ''));
    row.append(el('span', 'bb-message-sender', message.sender));
    const bubble = el('div', 'bb-bubble' + (message.type !== 'text' ? ` bb-card bb-card-${message.type}` : ''));
    if (message.type === 'text') bubble.textContent = message.content;
    else if (message.type === 'voice') {
        if (!getSettings().voiceEnabled) {
            bubble.className = 'bb-bubble bb-voice-text';
            bubble.textContent = message.content;
        } else {
            const expanded = expandedVoiceIds.has(message.id);
            const transcript = el('div', 'bb-voice-transcript');
            transcript.id = `bb-voice-${fingerprint(message.id)}`;
            transcript.hidden = !expanded;
            transcript.append(el('span', 'bb-card-caption', '转文字'), el('p', 'bb-card-text', message.content));
            const play = el('button', 'bb-voice-play'); play.type = 'button';
            play.dataset.bbVoice = message.id;
            play.setAttribute('aria-label', '展开语音消息的文字');
            play.setAttribute('aria-expanded', String(expanded));
            play.setAttribute('aria-controls', transcript.id);
            const icon = el('span', 'bb-voice-play-icon'); icon.innerHTML = icons.play(20);
            play.append(icon, el('strong', '', '语音消息'), cardIcon('voice'));
            bubble.append(play, transcript);
        }
    } else if (message.type === 'image') {
        const heading = el('div', 'bb-card-heading'); heading.append(cardIcon('image'), el('strong', '', '图片'));
        bubble.append(heading, el('p', 'bb-card-text', message.content), el('span', 'bb-card-caption', '画面描述'));
    } else if (message.type === 'location') {
        const heading = el('div', 'bb-card-heading'); heading.append(cardIcon('location'), el('strong', '', message.content));
        bubble.append(heading); if (message.note) bubble.append(el('p', 'bb-card-text', message.note));
        bubble.append(el('span', 'bb-card-caption', '共享位置'));
    } else {
        const heading = el('div', 'bb-card-heading'); heading.append(cardIcon('transfer'), el('strong', 'bb-transfer-amount', `¥${message.content}`));
        bubble.append(heading); if (message.note) bubble.append(el('p', 'bb-card-text', message.note));
        bubble.append(el('span', 'bb-card-caption', message.status === 'accepted' ? '已收款'
            : message.status === 'returned' ? '已退还' : message.isSelf ? '等待对方收款' : '待收款'));
        if (!message.status && !message.isSelf) {
            const actions = el('div', 'bb-transfer-actions');
            for (const [status, label] of [['accepted', '收款'], ['returned', '退还']]) {
                const button = el('button', 'bb-transfer-action', label); button.type = 'button';
                button.dataset.bbTransfer = message.id; button.dataset.bbTransferStatus = status;
                button.disabled = transferPending; actions.append(button);
            }
            bubble.append(actions);
        }
    }
    row.append(bubble); return row;
}

function renderConversation() {
    markConversationRead(conversationId);
    const state = getChatState(), conversation = state.conversations.find(c => c.id === conversationId);
    if (!conversation) return emptyState('这段会话已没有消息', '对应楼层可能已删除，或当前 swipe 没有手机消息。返回消息页查看其他会话。');
    const wrap = el('div', 'bb-chat');
    const header = el('header', 'bb-chat-header');
    const back = el('button', 'bb-back', '‹'); back.type = 'button'; back.dataset.bbAction = 'back';
    back.setAttribute('aria-label', '返回消息列表');
    const title = el('div', 'bb-chat-heading');
    const presentText = state.present === null ? '在场信息未知' : conversation.members.some(name => state.present.includes(name))
        ? '最近记录：与你同场' : '最近记录：不在你身边';
    title.append(el('h3', 'bb-chat-name', conversation.name), el('p', 'bb-presence', presentText));
    if (state.presentFloor !== null) title.querySelector('.bb-presence').title = `来自第 ${state.presentFloor + 1} 楼的在场名单`;
    header.append(back, title); wrap.append(header);
    const messages = el('div', 'bb-message-list');
    let previousFloor = -1;
    for (const message of conversation.messages) {
        if (message.pending && previousFloor !== null) {
            messages.append(el('p', 'bb-floor-divider', '手机聊天 · 下一轮剧情后保存到楼层'));
            previousFloor = null;
        } else if (!message.pending && message.floorIndex !== previousFloor) {
            const divider = el('button', 'bb-floor-divider', `第 ${message.floorIndex + 1} 楼${message.source === 'phone' ? ' · 手机聊天' : ''} ↗`);
            divider.type = 'button'; divider.dataset.bbFloorMessage = message.id;
            divider.setAttribute('aria-label', `返回酒馆第 ${message.floorIndex + 1} 楼`);
            messages.append(divider); previousFloor = message.floorIndex;
        }
        messages.append(renderMessage(message));
    }
    wrap.append(messages);
    const status = getPhoneStatus(conversation.name);
    if (status.phase === 'waiting' || status.phase === 'typing') {
        const typing = el('p', 'bb-phone-status', '对方正在输入…'); typing.setAttribute('role', 'status'); wrap.append(typing);
    } else if (status.phase === 'error' || (conversation.messages.at(-1)?.pending && conversation.messages.at(-1)?.isSelf)) {
        const warning = el('div', 'bb-phone-status is-error');
        warning.append(el('span', '', status.error || '待回复的消息已保留'));
        const retry = el('button', 'bb-reply-retry', '重试回复'); retry.type = 'button'; retry.dataset.bbAction = 'retry-reply'; warning.append(retry); wrap.append(warning);
    }
    const allowed = getStoryContacts().includes(conversation.name) && !isGenerationBusy();
    const composeWrap = el('div', 'bb-compose-wrap');
    const draft = currentDraft();
    if (attachmentType === 'menu') {
        const menu = el('div', 'bb-attachments');
        for (const [type, label] of [['voice', '语音'], ['transfer', '转账'], ['image', '图片'], ['location', '定位']]) {
            const button = el('button', 'bb-attachment-option', label); button.type = 'button'; button.dataset.bbAttachment = type; menu.append(button);
        }
        composeWrap.append(menu);
    } else if (attachmentType) {
        const labels = { voice: ['语音消息', '写下语音里说的话'], transfer: ['转账', '金额，例如 20.00'], image: ['图片', '描述你发的照片画面'], location: ['定位', '地点名称'] };
        const form = el('div', 'bb-attachment-form'); form.append(el('strong', '', labels[attachmentType][0]));
        const content = el('input', 'bb-settings-input bb-attachment-input'); content.value = draft.content; content.placeholder = labels[attachmentType][1]; content.dataset.bbDraft = 'content';
        if (attachmentType === 'transfer') content.inputMode = 'decimal';
        form.append(content);
        if (attachmentType === 'transfer' || attachmentType === 'location') {
            const note = el('input', 'bb-settings-input bb-attachment-input'); note.value = draft.note; note.placeholder = '备注（可不填）'; note.dataset.bbDraft = 'note'; form.append(note);
        }
        const send = el('button', 'bb-compose-send', '发送'); send.type = 'button'; send.dataset.bbAction = 'send-attachment'; send.disabled = !allowed || sending;
        const cancel = el('button', 'bb-reply-retry', '取消'); cancel.type = 'button'; cancel.dataset.bbAction = 'cancel-attachment';
        form.append(send, cancel, el('span', 'bb-switch-hint', attachmentType === 'image' ? '发送画面描述；暂不上传或生成图片。' : attachmentType === 'voice' ? '发送语音文字；声音播放在第六段接入。' : '')); composeWrap.append(form);
    }
    const composer = el('div', 'bb-composer');
    const plus = el('button', 'bb-composer-plus', '+'); plus.type = 'button'; plus.disabled = !allowed || sending; plus.dataset.bbAction = 'attachments'; plus.setAttribute('aria-label', '添加语音、转账、图片或定位');
    const input = el('input', 'bb-compose-input'); input.placeholder = allowed ? '发一条消息…' : '等待剧情结束，或选择角色卡联系人'; input.disabled = !allowed || sending; input.value = draft.text; input.dataset.bbDraft = 'text'; input.setAttribute('aria-label', '手机消息');
    const send = el('button', 'bb-compose-send', '发送'); send.type = 'button'; send.dataset.bbAction = 'send-text'; send.disabled = !allowed || sending;
    composer.append(plus, input, send); composeWrap.append(composer); wrap.append(composeWrap);
    return wrap;
}

function renderContacts() {
    const names = getStoryContacts();
    if (!names.length) return emptyState('还没有联系人', '先打开一个角色聊天；从世界书提取更多联系人将在第五段开放。');
    const wrap = el('div', 'bb-settings');
    wrap.append(el('p', 'bb-switch-hint', '当前使用角色卡联系人，群聊使用未停用的成员。更多联系人将在第五段开放。'));
    for (const name of names) {
        const row = el('button', 'bb-entry-setting bb-contact-row'); row.type = 'button'; row.dataset.bbConversation = `name:${name.normalize('NFC')}`;
        row.append(el('span', 'bb-switch-title', name), el('span', 'bb-switch-hint', '主动程度使用设置页的默认值'));
        wrap.append(row);
    }
    return wrap;
}

function settingsChoices(title, key, current, choices) {
    const field = el('fieldset', 'bb-field');
    field.append(el('legend', 'bb-field-label', title));
    const seg = el('div', choices.length === 2 ? 'bb-seg bb-seg-two' : 'bb-seg');
    for (const [value, text] of choices) {
        const input = el('input'); input.type = 'radio'; input.name = `bb-${key}`; input.id = `bb-${key}-${value}`;
        input.value = String(value); input.checked = current === value; input.dataset.bbSetting = key;
        const label = el('label', null, text); label.htmlFor = input.id;
        seg.append(input, label);
    }
    field.append(seg); return field;
}

function renderSettings() {
    const s = getSettings();
    const wrap = el('div', 'bb-settings');

    // 配色
    const themeField = el('fieldset', 'bb-field');
    themeField.append(el('legend', 'bb-field-label', '配色'));
    const seg = el('div', 'bb-seg');
    [['auto', '跟随系统'], ['day', '日间'], ['night', '夜间']].forEach(([value, label]) => {
        const id = `bb-theme-${value}`;
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'bb-theme';
        input.id = id;
        input.value = value;
        input.checked = s.theme === value;
        input.dataset.bbSetting = 'theme';
        const lab = el('label', null, label);
        lab.htmlFor = id;
        seg.append(input, lab);
    });
    themeField.append(seg);

    const entryField = el('div', 'bb-entry-setting');
    entryField.append(el('span', 'bb-switch-title', '入口显示方式'));
    entryField.append(createEntryModeControl(), el('span', 'bb-switch-hint', '悬浮球可拖动，位置会记住；切换立即生效。'));

    // 正文消息提醒
    const notice = el('label', 'bb-switch');
    const text = el('span', 'bb-switch-text');
    text.append(
        el('span', 'bb-switch-title', '正文里显示消息提醒'),
        el('span', 'bb-switch-hint', '在对应楼层显示提醒，点击直接打开会话；关闭后消息仍保留。'),
    );
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'bb-toggle';
    toggle.checked = !!s.inlineNotice;
    toggle.dataset.bbSetting = 'inlineNotice';
    notice.append(text, toggle);

    const thinking = el('label', 'bb-entry-setting');
    thinking.append(el('span', 'bb-switch-title', '忽略的思考标签'), el('span', 'bb-switch-hint', '逗号分隔标签名，思考中的手机消息不会计入。'));
    const tagInput = el('input', 'bb-settings-input'); tagInput.type = 'text'; tagInput.value = s.thinkTags.join(', ');
    tagInput.dataset.bbSetting = 'thinkTags'; tagInput.autocapitalize = 'off'; tagInput.spellcheck = false;
    thinking.append(tagInput);
    const voice = el('label', 'bb-switch');
    const voiceText = el('span', 'bb-switch-text');
    voiceText.append(el('span', 'bb-switch-title', '语音消息模式'),
        el('span', 'bb-switch-hint', '开启后点击语音卡片展开文字，关闭后直接显示文字。声音播放随后开放。'));
    const voiceToggle = el('input', 'bb-toggle'); voiceToggle.type = 'checkbox';
    voiceToggle.checked = s.voiceEnabled; voiceToggle.dataset.bbSetting = 'voiceEnabled';
    voice.append(voiceText, voiceToggle);
    const proactive = el('label', 'bb-switch');
    const proactiveText = el('span', 'bb-switch-text');
    proactiveText.append(el('span', 'bb-switch-title', '角色主动发消息'),
        el('span', 'bb-switch-hint', '随主线剧情发来手机消息；关闭后仍记录谁与你同场。'));
    const proactiveToggle = el('input', 'bb-toggle'); proactiveToggle.type = 'checkbox';
    proactiveToggle.checked = s.proactiveEnabled; proactiveToggle.dataset.bbSetting = 'proactiveEnabled';
    proactive.append(proactiveText, proactiveToggle);
    const level = settingsChoices('默认主动程度', 'proactiveLevel', s.proactiveLevel,
        [['restrained', '克制'], ['normal', '正常'], ['clingy', '黏人']]);
    level.append(el('span', 'bb-switch-hint', '克制：确有理由才发；正常：有合适时机就发；黏人：没事也会找你。同场时都不发。'));
    const cooldown = el('label', 'bb-entry-setting');
    cooldown.append(el('span', 'bb-switch-title', '冷却楼数'),
        el('span', 'bb-switch-hint', '两次主动消息之间至少隔几楼，用户消息也计一楼。0 表示不设冷却。'));
    const cooldownInput = el('input', 'bb-settings-input'); cooldownInput.type = 'number';
    cooldownInput.inputMode = 'numeric'; cooldownInput.min = '0'; cooldownInput.step = '1';
    cooldownInput.value = String(s.proactiveCooldown); cooldownInput.dataset.bbSetting = 'proactiveCooldown';
    cooldown.append(cooldownInput);
    const depth = settingsChoices('手机规则位置', 'proactiveDepth', s.proactiveDepth,
        [[0, '靠近最新消息'], [1, '提前一楼']]);
    depth.append(el('span', 'bb-switch-hint', '默认靠近最新消息。若常用预设不遵守规则，可试试提前一楼。'));
    const phoneSettings = el('div', 'bb-phone-settings');
    for (const [key, title, hint, min, max] of [
        ['phoneModel', '手机回复模型', '留空跟随酒馆当前模型。用 Flash 时填当前连接支持的准确模型 ID；不需要重复填 key。'],
        ['recentStoryCount', '无结绳时的近期剧情楼数', '有有效结绳记忆时，使用总结、脉络和实际未隐藏剧情。', 1, 200],
        ['phoneHistoryCount', '手机回复记录条数', '只限制带给模型的会话记录，不删除暂存消息。', 1, 200],
        ['phoneDebounceMs', '连发等待（毫秒）', '默认 1500 毫秒；连续发消息后合并回复。', 0, 10000],
        ['phoneReplyTokens', '手机回复最大 token', '默认 1024，供短消息回复使用。', 128, 8192],
        ['bodyTag', '剧情正文标签', '默认 content；找不到时使用去除思考、手机和状态块的正文。'],
        ['statusTags', '排除的状态栏标签', '逗号分隔，不把这些块带给手机回复模型。'],
    ]) {
        const field = el('label', 'bb-entry-setting'); field.append(el('span', 'bb-switch-title', title), el('span', 'bb-switch-hint', hint));
        const input = el('input', 'bb-settings-input'); input.type = min === undefined ? 'text' : 'number'; input.value = Array.isArray(s[key]) ? s[key].join(', ') : String(s[key]); input.dataset.bbSetting = key;
        if (min !== undefined) { input.min = String(min); input.max = String(max); input.step = '1'; input.inputMode = 'numeric'; }
        field.append(input); phoneSettings.append(field);
    }
    wrap.append(themeField, entryField, proactive, level, cooldown, depth, notice, voice, thinking, phoneSettings, el('p', 'bb-version', `青鸟 · Bluebird ${VERSION}`));
    return wrap;
}

const pages = {
    list: renderList,
    conversation: renderConversation,
    contacts: renderContacts,
    settings: renderSettings,
};

// ---------- 渲染与事件 ----------

function render() {
    if (!root) return;
    root.querySelector('.bb-story').textContent = storyLabel();
    root.querySelectorAll('.bb-tab').forEach((btn) => {
        const active = btn.dataset.bbPage === page || (page === 'conversation' && btn.dataset.bbPage === 'list');
        btn.classList.toggle('is-active', active);
        if (active) btn.setAttribute('aria-current', 'page');
        else btn.removeAttribute('aria-current');
    });
    const active = document.activeElement;
    const draftKey = active?.dataset?.bbDraft;
    const selection = draftKey ? [active.selectionStart, active.selectionEnd] : null;
    root.querySelector('.bb-body').replaceChildren(pages[page]());
    if (draftKey) {
        const next = root.querySelector(`[data-bb-draft="${draftKey}"]`);
        if (next && !next.disabled) { next.focus({ preventScroll: true }); if (typeof next.setSelectionRange === 'function' && selection[0] !== null) next.setSelectionRange(...selection); }
    }
}

async function onClick(event) {
    const btn = event.target.closest('button');
    if (!btn || !root.contains(btn)) return;
    if (btn.dataset.bbAction === 'close') {
        closePanel();
        return;
    }
    if (btn.dataset.bbAction === 'send-text' || btn.dataset.bbAction === 'send-attachment') { await submitPhone(btn.dataset.bbAction === 'send-text'); return; }
    if (btn.dataset.bbAction === 'retry-reply') {
        const name = getChatState().conversations.find(c => c.id === conversationId)?.name;
        try { retryPhoneReply(name); } catch (error) { toastr.info(error.message); } return;
    }
    if (btn.dataset.bbAction === 'attachments') { attachmentType = attachmentType ? null : 'menu'; render(); return; }
    if (btn.dataset.bbAction === 'cancel-attachment') { attachmentType = null; render(); return; }
    if (btn.dataset.bbAttachment) { attachmentType = btn.dataset.bbAttachment; currentDraft().content = ''; currentDraft().note = ''; render(); root.querySelector('[data-bb-draft="content"]')?.focus(); return; }
    if (btn.dataset.bbAction === 'back') { page = 'list'; conversationId = null; render(); return; }
    if (btn.dataset.bbConversation) { openConversation(btn.dataset.bbConversation); return; }
    if (btn.dataset.bbVoice) {
        const id = btn.dataset.bbVoice;
        const message = getChatState().byId.get(id);
        if (!message || message.type !== 'voice') { refreshPanel(); return; }
        expandedVoiceIds.add(id);
        const transcript = btn.closest('.bb-card-voice')?.querySelector('.bb-voice-transcript');
        if (transcript) transcript.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        return;
    }
    if (btn.dataset.bbFloorMessage) {
        const message = getChatState().byId.get(btn.dataset.bbFloorMessage);
        if (!message) { toastr.info('这条消息已经改变，请重新打开会话'); return; }
        closePanel();
        try { await scrollToFloor(message); } catch (error) { toastr.info(error.message); }
        return;
    }
    if (btn.dataset.bbTransfer) {
        if (transferPending) return;
        transferPending = true;
        root.querySelectorAll('[data-bb-transfer]').forEach(node => { node.disabled = true; });
        try { await processTransfer(btn.dataset.bbTransfer, btn.dataset.bbTransferStatus); }
        catch (error) { toastr.error(error.message || '转账状态保存失败，请重试'); }
        finally { transferPending = false; if (isOpen && page === 'conversation') render(); }
        return;
    }
    if (btn.dataset.bbPage && btn.dataset.bbPage !== page) {
        page = btn.dataset.bbPage;
        conversationId = null;
        render();
    }
}

async function submitPhone(isText) {
    if (sending) return;
    const id = conversationId, name = getChatState().conversations.find(c => c.id === id)?.name;
    const owner = captureCurrentChat(), draft = currentDraft(), type = isText ? 'text' : attachmentType;
    const content = isText ? draft.text : draft.content, note = isText ? '' : draft.note;
    sending = true; render();
    try {
        await sendPhoneMessage(name, type, content, note);
        if (isText) draft.text = ''; else { draft.content = ''; draft.note = ''; if (conversationId === id && currentChatMatches(owner)) attachmentType = null; }
    } catch (error) { toastr.error(error.message || '发送失败，输入已保留'); }
    finally { sending = false; if (currentChatMatches(owner) && isOpen && conversationId === id) { render(); root.querySelector('.bb-compose-input')?.focus({ preventScroll: true }); } }
}

function onInput(event) {
    const key = event.target.dataset?.bbDraft;
    if (key && page === 'conversation') currentDraft()[key] = event.target.value;
}

function onChange(event) {
    const input = event.target;
    if (input.disabled) return;
    const key = input.dataset?.bbSetting;
    if (!key) return;
    if (['phoneModel', 'bodyTag', 'statusTags', 'recentStoryCount', 'phoneHistoryCount', 'phoneDebounceMs', 'phoneReplyTokens'].includes(key)) {
        if (key === 'statusTags') setSetting(key, input.value.split(/[,，\s]+/).filter(t => /^[a-z][a-z0-9_-]*$/i.test(t)));
        else if (key === 'phoneModel') setSetting(key, input.value.trim());
        else if (key === 'bodyTag' && /^[a-z][a-z0-9_-]*$/i.test(input.value.trim())) setSetting(key, input.value.trim());
        else if (key !== 'bodyTag' && input.value.trim() && Number.isSafeInteger(Number(input.value)) && Number(input.value) >= Number(input.min) && Number(input.value) <= Number(input.max)) setSetting(key, Number(input.value));
        else { input.value = String(getSettings()[key]); toastr.info('请输入有效的设置值'); }
        return;
    }
    if (key === 'theme') {
        setSetting('theme', input.value);
        applyThemeEverywhere();
    } else if (key === 'inlineNotice') {
        setSetting('inlineNotice', input.checked);
    } else if (key === 'voiceEnabled') {
        expandedVoiceIds.clear();
        setSetting('voiceEnabled', input.checked);
    } else if (key === 'thinkTags') {
        setSetting('thinkTags', input.value.split(/[,，\s]+/).map(s => s.trim().toLowerCase()).filter(s => /^[a-z][a-z0-9_-]*$/.test(s)));
    } else if (key === 'proactiveEnabled') {
        setSetting(key, input.checked);
    } else if (key === 'proactiveLevel' && ['restrained', 'normal', 'clingy'].includes(input.value)) {
        setSetting(key, input.value);
    } else if (key === 'proactiveDepth' && ['0', '1'].includes(input.value)) {
        setSetting(key, Number(input.value));
    } else if (key === 'proactiveCooldown') {
        const value = Number(input.value);
        if (input.value.trim() && Number.isSafeInteger(value) && value >= 0) setSetting(key, value);
        else { input.value = String(getSettings().proactiveCooldown); toastr.info('冷却楼数请填写 0 或正整数'); }
    }
}

function onKeydown(event) {
    if (!isOpen || event.isComposing) return;
    if (event.key === 'Enter' && event.target?.classList?.contains('bb-compose-input')) { event.preventDefault(); event.stopPropagation(); submitPhone(true); return; }
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closePanel();
    } else if (event.key === 'Tab') {
        const controls = focusableControls();
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first) {
            event.preventDefault();
            root.querySelector('.bb-phone').focus({ preventScroll: true });
        } else if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) {
            event.preventDefault();
            last.focus({ preventScroll: true });
        } else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) {
            event.preventDefault();
            first.focus({ preventScroll: true });
        }
    }
}

// ---------- 对外接口 ----------

export function mountPanel() {
    if (root) return root;
    root = el('div', 'bb-root');
    root.id = 'bluebird-panel';
    root.dataset.bbThemed = '';
    root.hidden = true;
    root.innerHTML = `
        <section class="bb-phone" role="dialog" aria-modal="true" aria-label="青鸟" tabindex="-1">
            <header class="bb-header">
                <div class="bb-brand">${icons.bird(28)}<h2 class="bb-title">青鸟</h2></div>
                <button type="button" class="bb-icon-btn" data-bb-action="close" aria-label="收起青鸟">${icons.close()}</button>
            </header>
            <p class="bb-story"></p>
            <main class="bb-body"></main>
            <nav class="bb-tabs" aria-label="青鸟页面">
                <button type="button" class="bb-tab" data-bb-page="list">${icons.chat()}<span>消息</span></button>
                <button type="button" class="bb-tab" data-bb-page="contacts">${icons.contacts()}<span>通讯录</span></button>
                <button type="button" class="bb-tab" data-bb-page="settings">${icons.settings()}<span>设置</span></button>
            </nav>
        </section>`;
    document.body.appendChild(root);
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
    root.addEventListener('keydown', onKeydown);
    applyThemeEverywhere();
    return root;
}

export function openPanel() {
    if (!getSettings().enabled) return;
    mountPanel();
    if (isOpen) return;
    rebuildChatState('open');
    returnFocus = document.activeElement;
    root.hidden = false;
    isOpen = true;
    document.documentElement.classList.add('bb-open');
    render();
    root.querySelector('[data-bb-action="close"]').focus({ preventScroll: true });
    lockBackground();
}

export function closePanel() {
    if (!root || !isOpen) return;
    root.hidden = true;
    isOpen = false;
    document.documentElement.classList.remove('bb-open');
    unlockBackground();
    const target = returnFocus?.isConnected && !returnFocus.disabled
        && !returnFocus.closest('[hidden], [inert]') && returnFocus.getClientRects().length > 0
        ? returnFocus : document.querySelector('#bluebird-entry[data-bb-entry-mode="floating"] button')
            || document.getElementById('extensionsMenuButton') || document.getElementById('send_textarea');
    target?.focus({ preventScroll: true });
    returnFocus = null;
}

export function togglePanel() {
    if (isOpen) closePanel();
    else openPanel();
}

/** 切换聊天后刷新剧情名等内容。 */
export function refreshPanel(reason = 'update') {
    if (reason === 'chat' || reason === 'voice-mode') expandedVoiceIds.clear();
    if (reason === 'chat') { drafts.clear(); attachmentType = null; conversationId = null; if (page === 'conversation') page = 'list'; }
    if (!getSettings().enabled) { closePanel(); return; }
    if (isOpen && page !== 'settings' && reason !== 'read') {
        const body = root.querySelector('.bb-body'), top = body.scrollTop;
        const atBottom = body.scrollHeight - body.clientHeight - top < 80;
        render();
        body.scrollTop = page === 'conversation' && atBottom ? body.scrollHeight : top;
    }
}

export function openConversation(id) {
    if (!getSettings().enabled) return;
    openPanel();
    if (conversationId !== id) attachmentType = null;
    conversationId = id; page = 'conversation'; render();
    const body = root.querySelector('.bb-body'); body.scrollTop = body.scrollHeight;
    root.querySelector('[data-bb-action="back"]')?.focus({ preventScroll: true });
}
