// 青鸟 · 入口：悬浮球 / 魔法棒，互斥显示，不占用输入栏。

import { icons } from './icons.js?v=0.6.1';
import { getSettings, setSetting, applyThemeEverywhere } from './settings.js?v=0.6.1';
import { togglePanel, openPanel, closePanel } from './panel.js?v=0.6.1';
import { createEntryModeControl, syncEntryModeControls } from './entry-controls.js?v=0.6.1';

let entry = null;
let cleanupEntry = null;
let unread = 0;

function syncSettingsControls() {
    const s = getSettings();
    const enabled = document.getElementById('bb-enabled');
    syncEntryModeControls();
    if (enabled) enabled.checked = s.enabled;
}

function floatBounds(button) {
    const viewport = window.visualViewport;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    const rect = button.getBoundingClientRect();
    const css = getComputedStyle(button);
    const safe = (edge) => Math.max(0, parseFloat(css.getPropertyValue(`--bb-safe-${edge}`)) || 0);
    const minX = 12 + safe('left');
    const minY = 12 + safe('top');
    return {
        minX, minY,
        maxX: Math.max(minX, width - rect.width - 12 - safe('right')),
        maxY: Math.max(minY, height - rect.height - 12 - safe('bottom')),
    };
}

function placeFloat(button, x, y, bounds = floatBounds(button)) {
    const left = Math.min(bounds.maxX, Math.max(bounds.minX, x));
    const top = Math.min(bounds.maxY, Math.max(bounds.minY, y));
    button.style.left = `${left}px`;
    button.style.top = `${top}px`;
    button.style.right = 'auto';
    button.style.bottom = 'auto';
    return { left, top, bounds };
}

function wireFloatingButton(button) {
    let drag = null;
    let suppressClick = false;
    let clickResetTimer = null;
    const restorePosition = () => {
        if (!button.isConnected || drag) return;
        const b = floatBounds(button);
        const p = getSettings().floatPosition;
        placeFloat(button,
            p ? b.minX + p.x * (b.maxX - b.minX) : b.maxX,
            p ? b.minY + p.y * (b.maxY - b.minY) : b.maxY - 128, b);
    };
    button.addEventListener('pointerdown', (event) => {
        if (!event.isPrimary || event.button !== 0) return;
        clearTimeout(clickResetTimer);
        suppressClick = false;
        const rect = button.getBoundingClientRect();
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY,
            left: rect.left, top: rect.top, moved: false };
        button.setPointerCapture(event.pointerId);
    });
    button.addEventListener('pointermove', (event) => {
        if (!drag || event.pointerId !== drag.id) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 8) return;
        drag.moved = true;
        button.classList.add('is-dragging');
        event.preventDefault();
        placeFloat(button, drag.left + dx, drag.top + dy);
    });
    const finishDrag = (event) => {
        if (!drag || event.pointerId !== drag.id) return;
        const moved = drag.moved;
        drag = null;
        button.classList.remove('is-dragging');
        if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
        if (moved && event.type === 'pointerup') {
            const rect = button.getBoundingClientRect();
            const { left, top, bounds: b } = placeFloat(button, rect.left, rect.top);
            setSetting('floatPosition', {
                x: (left - b.minX) / (b.maxX - b.minX || 1),
                y: (top - b.minY) / (b.maxY - b.minY || 1),
            });
            suppressClick = true;
            clickResetTimer = setTimeout(() => { suppressClick = false; }, 400);
        } else if (event.type !== 'pointerup') restorePosition();
    };
    button.addEventListener('pointerup', finishDrag);
    button.addEventListener('pointercancel', finishDrag);
    button.addEventListener('lostpointercapture', finishDrag);
    button.addEventListener('click', (event) => {
        if (suppressClick) {
            suppressClick = false;
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        togglePanel();
    });
    window.addEventListener('resize', restorePosition);
    window.visualViewport?.addEventListener('resize', restorePosition);
    const frame = requestAnimationFrame(restorePosition);
    return () => {
        clearTimeout(clickResetTimer);
        cancelAnimationFrame(frame);
        window.removeEventListener('resize', restorePosition);
        window.visualViewport?.removeEventListener('resize', restorePosition);
    };
}

export function entryIsMounted() {
    const s = getSettings();
    return !s.enabled || !!(entry?.isConnected && entry.dataset.bbEntryMode === s.entryMode);
}

export function mountEntry() {
    syncSettingsControls();
    const s = getSettings();
    if (!s.enabled) {
        unmountEntry();
        closePanel();
        return;
    }
    if (entryIsMounted()) return;
    unmountEntry();
    const host = s.entryMode === 'wand' ? document.getElementById('extensionsMenu') : document.body;
    if (!host) return; // 魔法棒菜单尚未挂载时，由初始化观察器补挂。
    entry = document.createElement('div');
    entry.id = 'bluebird-entry';
    entry.dataset.bbThemed = '';
    entry.dataset.bbEntryMode = s.entryMode;
    if (s.entryMode === 'wand') {
        entry.className = 'extension_container';
        entry.innerHTML = `<button type="button" class="bb-entry-button bb-wand list-group-item flex-container flexGap5" aria-label="打开青鸟" aria-haspopup="dialog">
            ${icons.bird(22)}<span>青鸟</span><span class="bb-badge" aria-hidden="true" hidden></span>
        </button>`;
    } else {
        entry.innerHTML = `<button type="button" class="bb-entry-button bb-float" aria-label="打开青鸟" aria-haspopup="dialog" title="青鸟（可拖动）">
            ${icons.bird(27)}<span class="bb-badge" aria-hidden="true" hidden></span>
        </button>`;
    }
    host.appendChild(entry);
    const button = entry.querySelector('.bb-entry-button');
    if (s.entryMode === 'floating') cleanupEntry = wireFloatingButton(button);
    else button.addEventListener('click', openPanel); // 由酒馆的冒泡处理收起魔法棒菜单。
    setUnread(unread);
    applyThemeEverywhere();
}

export function unmountEntry() {
    cleanupEntry?.();
    cleanupEntry = null;
    entry?.remove();
    entry = null;
}

/** 切换入口、停用再启用时保留未读数。 */
export function setUnread(count) {
    unread = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (!entry) return;
    const button = entry.querySelector('.bb-entry-button');
    const badge = entry.querySelector('.bb-badge');
    badge.hidden = unread === 0;
    badge.textContent = unread > 99 ? '99+' : String(unread);
    button.setAttribute('aria-label', unread ? `打开青鸟，${unread} 条未读` : '打开青鸟');
}

export function mountSettingsBlock() {
    if (document.getElementById('bluebird-settings')) return;
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;
    const box = document.createElement('div');
    box.id = 'bluebird-settings';
    box.dataset.bbThemed = '';
    box.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>青鸟 · Bluebird</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="bb-enabled">
                    <input type="checkbox" id="bb-enabled"><span>启用青鸟</span>
                </label>
                <div>入口显示方式</div>
                <div class="bb-entry-controls-slot"></div>
                <div id="bb-open" class="menu_button" role="button" tabindex="0">打开青鸟</div>
                <small>悬浮球可拖动，位置会记住；入口切换立即生效。</small>
            </div>
        </div>`;
    host.appendChild(box);
    box.querySelector('.bb-entry-controls-slot').appendChild(createEntryModeControl());
    syncSettingsControls();
    const enabled = box.querySelector('#bb-enabled');
    enabled.addEventListener('change', () => setSetting('enabled', enabled.checked));
    box.querySelector('#bb-open').addEventListener('click', () => {
        if (!getSettings().enabled) {
            toastr.info('先勾上「启用青鸟」');
            return;
        }
        openPanel();
    });
}
