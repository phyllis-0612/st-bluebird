// 青鸟 · 手机面板
// 手机端全屏面板。
// 第一段只有外壳和三个页面：消息、通讯录、设置。

import { icons } from './icons.js?v=0.1.3';
import { ctx, getSettings, setSetting, applyThemeEverywhere, VERSION } from './settings.js?v=0.1.3';
import { createEntryModeControl } from './entry-controls.js?v=0.1.3';

let root = null;
let page = 'list';
let isOpen = false;
let returnFocus = null;
const backgroundNodes = new Map();
let backgroundObserver = null;

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
    return emptyState('还没有消息', '消息收发将在后续版本开放，当前可以体验界面和配色。');
}

function renderContacts() {
    return emptyState('还没有联系人', '从角色卡和世界书一键提取联系人，会在之后的版本里加上。');
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
        el('span', 'bb-switch-title', '正文里显示消息提醒 · 待开放'),
        el('span', 'bb-switch-hint', '后续版本开放：在对应楼层显示提醒，点击打开青鸟'),
    );
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'bb-toggle';
    toggle.checked = !!s.inlineNotice;
    toggle.disabled = true;
    toggle.dataset.bbSetting = 'inlineNotice';
    notice.append(text, toggle);

    wrap.append(themeField, entryField, notice, el('p', 'bb-version', `青鸟 · Bluebird ${VERSION}`));
    return wrap;
}

const pages = {
    list: renderList,
    contacts: renderContacts,
    settings: renderSettings,
};

// ---------- 渲染与事件 ----------

function render() {
    if (!root) return;
    root.querySelector('.bb-story').textContent = storyLabel();
    root.querySelectorAll('.bb-tab').forEach((btn) => {
        const active = btn.dataset.bbPage === page;
        btn.classList.toggle('is-active', active);
        if (active) btn.setAttribute('aria-current', 'page');
        else btn.removeAttribute('aria-current');
    });
    root.querySelector('.bb-body').replaceChildren(pages[page]());
}

function onClick(event) {
    const btn = event.target.closest('button');
    if (!btn || !root.contains(btn)) return;
    if (btn.dataset.bbAction === 'close') {
        closePanel();
        return;
    }
    if (btn.dataset.bbPage && btn.dataset.bbPage !== page) {
        page = btn.dataset.bbPage;
        render();
    }
}

function onChange(event) {
    const input = event.target;
    if (input.disabled) return;
    const key = input.dataset?.bbSetting;
    if (!key) return;
    if (key === 'theme') {
        setSetting('theme', input.value);
        applyThemeEverywhere();
    } else if (key === 'inlineNotice') {
        setSetting('inlineNotice', input.checked);
    } else if (key === 'entryMode' && ['floating', 'wand'].includes(input.value)) {
        setSetting('entryMode', input.value);
    }
}

function onKeydown(event) {
    if (!isOpen || event.isComposing) return;
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
    root.addEventListener('keydown', onKeydown);
    applyThemeEverywhere();
    return root;
}

export function openPanel() {
    if (!getSettings().enabled) return;
    mountPanel();
    if (isOpen) return;
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
export function refreshPanel() {
    if (isOpen) render();
}
