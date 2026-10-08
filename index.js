// 青鸟 · Bluebird
// SillyTavern 小手机扩展：角色在剧情里主动给你发消息，手机里聊过的内容自然回到剧情。
// 当前进度：第一段 · 骨架

import { ctx, getSettings, watchSystemTheme } from './src/settings.js';
import { refreshPanel } from './src/panel.js';
import { mountEntry, mountSettingsBlock, entryIsMounted } from './src/entry.js';

let mountObserver = null;

function mountUI() {
    mountSettingsBlock();
    mountEntry();
    const settingsReady = document.getElementById('bluebird-settings');
    const entryReady = entryIsMounted();
    if (settingsReady && entryReady) {
        mountObserver?.disconnect();
        mountObserver = null;
    }
    return !!(settingsReady && entryReady);
}

function ensureUI() {
    if (mountUI() || mountObserver) return;
    // 初次加载时容器可能尚未出现；出现后补挂，挂载完成就停止观察。
    mountObserver = new MutationObserver(() => {
        try {
            mountUI();
        } catch (error) {
            mountObserver?.disconnect();
            mountObserver = null;
            console.error('[青鸟] 界面补挂失败', error);
            toastr.error('青鸟界面加载失败，请刷新后重试');
        }
    });
    mountObserver.observe(document.body, { childList: true, subtree: true });
}

function init() {
    getSettings();          // 补齐默认设置
    document.addEventListener('bluebird:entry-changed', ensureUI);
    ensureUI();             // 扩展设置块和输入框入口，必要时补挂
    watchSystemTheme();     // 「跟随系统」时跟着系统换深浅色

    const context = ctx();
    const events = context.eventTypes || context.event_types;
    context.eventSource.on(events.CHAT_CHANGED, () => refreshPanel());
    if (events.APP_INITIALIZED) context.eventSource.on(events.APP_INITIALIZED, ensureUI);
    if (events.APP_READY) context.eventSource.on(events.APP_READY, ensureUI);

    console.log('[青鸟] 已加载');
}

jQuery(() => {
    try {
        init();
    } catch (error) {
        console.error('[青鸟] 初始化失败', error);
        toastr.error('青鸟初始化失败，详情见浏览器控制台');
    }
});
