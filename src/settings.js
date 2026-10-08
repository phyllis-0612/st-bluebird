// 青鸟 · 设置读写与配色
// 设置存在酒馆的 extensionSettings.bluebird 里，跟着酒馆设置一起保存。

export const VERSION = '0.1.3';

const KEY = 'bluebird';
const settingListeners = new Set();

/** 直接通知插件内部订阅者，避免依赖酒馆全局 DOM 事件。 */
export function onSettingChanged(listener) {
    settingListeners.add(listener);
    return () => settingListeners.delete(listener);
}

const DEFAULTS = Object.freeze({
    enabled: true,
    theme: 'auto',       // auto 跟随系统 | day 日间 | night 夜间
    inlineNotice: true,  // 正文里显示「某某发来几条消息」（第三段生效）
    entryMode: 'floating', // floating 悬浮球 | wand 魔法棒
    floatPosition: null,   // 拖动后保存为可用屏幕范围内的比例位置
});

export function ctx() {
    return SillyTavern.getContext();
}

/** 取设置；缺的字段用默认值补上，旧版本存档升级时不会丢字段。 */
export function getSettings() {
    const store = ctx().extensionSettings;
    if (!store[KEY] || typeof store[KEY] !== 'object' || Array.isArray(store[KEY])) {
        store[KEY] = {};
    }
    const s = store[KEY];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = v;
    }
    if (typeof s.enabled !== 'boolean') s.enabled = DEFAULTS.enabled;
    if (typeof s.inlineNotice !== 'boolean') s.inlineNotice = DEFAULTS.inlineNotice;
    if (!['auto', 'day', 'night'].includes(s.theme)) s.theme = DEFAULTS.theme;
    if (!['floating', 'wand'].includes(s.entryMode)) s.entryMode = DEFAULTS.entryMode;
    const p = s.floatPosition;
    if (p !== null && (!p || Array.isArray(p) || typeof p !== 'object'
        || !Number.isFinite(p.x) || !Number.isFinite(p.y)
        || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) s.floatPosition = null;
    return s;
}

export function setSetting(key, value) {
    getSettings()[key] = value;
    ctx().saveSettingsDebounced();
    for (const listener of settingListeners) listener(key, value);
}

// ---------- 配色 ----------

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let watchingSystemTheme = false;

/** 实际用哪套颜色：day 或 night。 */
export function resolveTheme() {
    const t = getSettings().theme;
    if (t === 'day' || t === 'night') return t;
    return darkQuery.matches ? 'night' : 'day';
}

/** 给所有带 data-bb-themed 的节点（面板、青鸟入口）刷上当前配色。 */
export function applyThemeEverywhere() {
    const theme = resolveTheme();
    document.querySelectorAll('[data-bb-themed]').forEach((node) => {
        node.dataset.bbTheme = theme;
    });
}

/** 系统深浅色变化时，「跟随系统」模式要跟着换。 */
export function watchSystemTheme() {
    if (watchingSystemTheme) return;
    watchingSystemTheme = true;
    const handler = () => {
        if (getSettings().theme === 'auto') applyThemeEverywhere();
    };
    if (darkQuery.addEventListener) {
        darkQuery.addEventListener('change', handler);
    } else if (darkQuery.addListener) {
        darkQuery.addListener(handler); // 老 Safari
    }
}
