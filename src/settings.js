// 青鸟 · 设置读写与配色
// 设置存在酒馆的 extensionSettings.bluebird 里，跟着酒馆设置一起保存。

export const VERSION = '0.6.8';

const KEY = 'bluebird';
const settingListeners = new Set();
const TAG_NAME = /^[\p{L}][\p{L}\p{N}_-]*$/u;

export function normalizeTagName(value) {
    const name = String(value || '').trim().replace(/^<\s*\/?\s*/, '').replace(/\s*>$/, '').trim();
    return TAG_NAME.test(name) ? name.toLowerCase() : '';
}

export function parseTagNames(value) {
    return [...new Set(String(value || '').split(/[,，、\s]+/u).map(normalizeTagName).filter(Boolean))];
}

/** 直接通知插件内部订阅者，避免依赖酒馆全局 DOM 事件。 */
export function onSettingChanged(listener) {
    settingListeners.add(listener);
    return () => settingListeners.delete(listener);
}

const DEFAULTS = Object.freeze({
    enabled: true,
    theme: 'auto',       // auto 跟随系统 | day 日间 | night 夜间
    inlineNotice: true,  // 正文里显示「某某发来几条消息」
    voiceEnabled: true,  // 语音消息显示为可点击卡片；关闭则直接显示文字
    voiceProvider: 'minimax', // 青鸟统一使用的语音服务；角色音色按服务分别保存
    proactiveEnabled: true,
    proactiveLevel: 'normal',
    proactiveCooldown: 3, // 两次主线来信之间隔开的楼层，用户楼层也计入
    proactiveDepth: 0,
    phoneModel: '', // 留空跟随酒馆模型；可填写当前连接支持的 Flash 模型 ID
    apiPresets: [], // 青鸟独立 OpenAI 兼容预设；空表示跟随酒馆
    activeApiPresetId: 'tavern',
    ttsMiniMax: { baseUrl: 'https://api.minimaxi.com', apiKey: '', groupId: '', model: 'speech-2.8-hd' },
    ttsElevenLabs: { baseUrl: 'https://api.elevenlabs.io', apiKey: '', model: 'eleven_v4' },
    voiceCacheMB: 200,
    recentStoryCount: 20,
    phoneHistoryCount: 30,
    phoneReplyTokens: 1024,
    bodyTag: 'content',
    statusTags: ['status', 'statusbar', 'state', 'details'],
    thinkTags: ['think', 'thinking', 'analysis', 'reasoning'],
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
    if (s.voiceProvider === undefined && ['minimax', 'elevenlabs'].includes(store.playhouse?.tts?.provider)) s.voiceProvider = store.playhouse.tts.provider;
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = Array.isArray(v) ? [...v] : v && typeof v === 'object' ? { ...v } : v;
    }
    if (typeof s.enabled !== 'boolean') s.enabled = DEFAULTS.enabled;
    if (typeof s.inlineNotice !== 'boolean') s.inlineNotice = DEFAULTS.inlineNotice;
    if (typeof s.voiceEnabled !== 'boolean') s.voiceEnabled = DEFAULTS.voiceEnabled;
    if (!['minimax', 'elevenlabs'].includes(s.voiceProvider)) s.voiceProvider = DEFAULTS.voiceProvider;
    if (typeof s.proactiveEnabled !== 'boolean') s.proactiveEnabled = DEFAULTS.proactiveEnabled;
    if (!['restrained', 'normal', 'clingy'].includes(s.proactiveLevel)) s.proactiveLevel = DEFAULTS.proactiveLevel;
    if (!Number.isSafeInteger(s.proactiveCooldown) || s.proactiveCooldown < 0) s.proactiveCooldown = DEFAULTS.proactiveCooldown;
    if (![0, 1].includes(s.proactiveDepth)) s.proactiveDepth = DEFAULTS.proactiveDepth;
    if (typeof s.phoneModel !== 'string') s.phoneModel = '';
    s.phoneModel = s.phoneModel.trim();
    if (!Array.isArray(s.apiPresets)) s.apiPresets = [];
    s.apiPresets = s.apiPresets.filter(p => p && typeof p === 'object' && typeof p.id === 'string' && typeof p.name === 'string');
    if (typeof s.activeApiPresetId !== 'string' || (s.activeApiPresetId !== 'tavern' && !s.apiPresets.some(p => p.id === s.activeApiPresetId))) s.activeApiPresetId = 'tavern';
    for (const [key, defaults] of [['ttsMiniMax', DEFAULTS.ttsMiniMax], ['ttsElevenLabs', DEFAULTS.ttsElevenLabs]]) {
        if (!s[key] || typeof s[key] !== 'object' || Array.isArray(s[key])) s[key] = {};
        for (const [field, value] of Object.entries(defaults)) if (typeof s[key][field] !== 'string') s[key][field] = value;
    }
    if (!Number.isSafeInteger(s.voiceCacheMB) || s.voiceCacheMB < 10 || s.voiceCacheMB > 1000) s.voiceCacheMB = 200;
    for (const [key, min, max] of [['recentStoryCount', 1, 200], ['phoneHistoryCount', 1, 200], ['phoneReplyTokens', 128, 8192]]) {
        if (!Number.isSafeInteger(s[key]) || s[key] < min || s[key] > max) s[key] = DEFAULTS[key];
    }
    s.bodyTag = normalizeTagName(s.bodyTag) || DEFAULTS.bodyTag;
    if (!Array.isArray(s.statusTags)) s.statusTags = [...DEFAULTS.statusTags];
    s.statusTags = [...new Set(s.statusTags.filter(t => typeof t === 'string').map(normalizeTagName).filter(Boolean))];
    if (!Array.isArray(s.thinkTags)) s.thinkTags = [...DEFAULTS.thinkTags];
    s.thinkTags = [...new Set(s.thinkTags.filter(t => typeof t === 'string').map(normalizeTagName).filter(Boolean))];
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
