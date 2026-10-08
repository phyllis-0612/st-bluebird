// 青鸟 · 入口
// 1. 输入框上方的「青鸟」按钮：插件自己加，不依赖快速回复扩展；未读数挂在按钮上当角标。
// 2. 扩展抽屉里的设置块：启用开关、打开青鸟。

import { icons } from './icons.js';
import { getSettings, setSetting, applyThemeEverywhere } from './settings.js';
import { togglePanel, openPanel, closePanel } from './panel.js';

let bar = null;

export function mountEntry() {
    if (bar?.isConnected || !getSettings().enabled) return;
    const form = document.getElementById('send_form');
    if (!form) {
        console.warn('[青鸟] 没找到 #send_form，青鸟按钮没有挂上');
        return;
    }
    bar = document.createElement('div');
    bar.id = 'bluebird-bar';
    bar.dataset.bbThemed = '';
    bar.innerHTML = `
        <button type="button" class="bb-qr" aria-label="打开青鸟">
            ${icons.bird(18)}<span>青鸟</span><span class="bb-badge" aria-hidden="true" hidden></span>
        </button>`;
    bar.querySelector('.bb-qr').addEventListener('click', togglePanel);
    form.prepend(bar);
    applyThemeEverywhere();
}

export function unmountEntry() {
    bar?.remove();
    bar = null;
}

/** 设置未读数，0 时隐藏角标。第三段开始真正调用。 */
export function setUnread(count) {
    if (!bar) return;
    const btn = bar.querySelector('.bb-qr');
    const badge = bar.querySelector('.bb-badge');
    if (count > 0) {
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.hidden = false;
        btn.setAttribute('aria-label', `打开青鸟，${count} 条未读`);
    } else {
        badge.hidden = true;
        btn.setAttribute('aria-label', '打开青鸟');
    }
}

export function mountSettingsBlock() {
    if (document.getElementById('bluebird-settings')) return;
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;

    const box = document.createElement('div');
    box.id = 'bluebird-settings';
    box.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>青鸟 · Bluebird</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="bb-enabled">
                    <input type="checkbox" id="bb-enabled">
                    <span>启用青鸟</span>
                </label>
                <div id="bb-open" class="menu_button">打开青鸟</div>
                <small>其余设置在青鸟面板的「设置」页里。</small>
            </div>
        </div>`;
    host.append(box);

    const enabled = box.querySelector('#bb-enabled');
    enabled.checked = getSettings().enabled;
    enabled.addEventListener('change', () => {
        setSetting('enabled', enabled.checked);
        if (enabled.checked) {
            mountEntry();
        } else {
            unmountEntry();
            closePanel();
        }
    });

    box.querySelector('#bb-open').addEventListener('click', () => {
        if (!getSettings().enabled) {
            toastr.info('先勾上「启用青鸟」');
            return;
        }
        openPanel();
    });
}
