// 第五段：联系人目录只存来源引用，世界书正文始终按需读取。
import { ctx, getSettings, setSetting } from './settings.js?v=0.6.4';
import { world_info } from '../../../../world-info.js';
import { storyContacts } from './messages.js?v=0.6.4';
import { requestBluebirdRaw } from './api.js?v=0.6.4';

const CONTACT_LEVELS = ['restrained', 'normal', 'clingy'];
const VOICE_PROVIDERS = ['minimax', 'elevenlabs'];
function voiceBindings(value) {
    const voices = {};
    for (const provider of VOICE_PROVIDERS) {
        const id = value?.[provider] || (value?.provider === provider ? value.voiceId : '');
        if (typeof id === 'string' && id.trim()) voices[provider] = id.trim();
    }
    return voices;
}
const filename = avatar => String(avatar || '').replace(/\.[^/.]+$/, '');
const ownerKey = context => context.groupId != null && context.groupId !== '' ? `group:${context.groupId}`
    : `card:${context.characters?.[context.characterId]?.avatar || context.characterId}`;

export function selectedContacts(context = ctx(), settings = getSettings()) {
    const cards = storyContacts(context).map(name => ({ name, source: { type: 'card' }, level: settings.proactiveLevel, voice: null }));
    const value = settings.contacts?.[ownerKey(context)];
    const saved = Array.isArray(value) ? value : [];
    const byName = new Map(cards.map(c => [c.name.normalize('NFC'), c]));
    for (const contact of saved) {
        if (!contact?.name || !contact?.source || !CONTACT_LEVELS.includes(contact.level)) continue;
        const key = contact.name.normalize('NFC');
        if (contact.source.type === 'world' && typeof contact.source.book === 'string' && Number.isSafeInteger(Number(contact.source.uid)) && !byName.has(key)) byName.set(key, contact);
        if (byName.has(key) && contact.source.type === 'card') { byName.get(key).level = contact.level; byName.get(key).voice = contact.voice || null; }
    }
    return [...byName.values()].map(contact => ({ ...contact, voice: voiceBindings(contact.voice) }));
}

export function saveContacts(list, context = ctx()) {
    const settings = getSettings();
    const contacts = { ...(settings.contacts && !Array.isArray(settings.contacts) ? settings.contacts : {}), [ownerKey(context)]: list.map(c => ({
        name: c.name.trim(), source: c.source.type === 'world'
            ? { type: 'world', book: c.source.book, uid: Number(c.source.uid) } : { type: 'card' }, level: c.level,
        voice: voiceBindings(c.voice),
    })) };
    setSetting('contacts', contacts);
}

export function boundBooks(context = ctx(), wi = world_info) {
    const characters = context.groupId != null && context.groupId !== ''
        ? (context.groups?.find(g => String(g.id) === String(context.groupId))?.members || [])
            .filter(a => !(context.groups?.find(g => String(g.id) === String(context.groupId))?.disabled_members || []).includes(a))
            .map(a => context.characters?.find(c => c.avatar === a)).filter(Boolean)
        : [context.characters?.[context.characterId]].filter(Boolean);
    const books = characters.flatMap(card => [card.data?.extensions?.world,
        ...(wi?.charLore?.find(item => item.name === filename(card.avatar))?.extraBooks || [])]);
    return [...new Set(books.filter(b => typeof b === 'string' && b.trim()))];
}

export async function readContactSource(context, contact) {
    if (!contact.source || contact.source.type === 'card') {
        const card = context.characters?.find(c => c.name?.trim() === contact.name);
        if (!card) throw new Error('角色卡联系人已经移除');
        return [card.description || card.data?.description, card.personality || card.data?.personality,
            card.scenario || card.data?.scenario].filter(Boolean).join('\n\n');
    }
    if (typeof context.loadWorldInfo !== 'function') throw new Error('当前酒馆无法读取世界书');
    const data = await context.loadWorldInfo(contact.source.book);
    const entry = Object.values(data?.entries || {}).find(e => String(e.uid) === String(contact.source.uid));
    if (!entry) throw new Error(`世界书「${contact.source.book}」的联系人条目已不存在，请重新提取`);
    return `${entry.comment || contact.name}\n${entry.content || ''}`;
}

export function parseCandidates(raw, sources) {
    const text = String(raw || '').replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();
    let list;
    try { const value = JSON.parse(text); list = Array.isArray(value) ? value : value.contacts; }
    catch { throw new Error('提取结果不是有效 JSON，请重试'); }
    if (!Array.isArray(list)) throw new Error('提取结果缺少联系人数组，请重试');
    return list.flatMap(item => {
        const source = sources.find(s => s.key === String(item.source));
        const name = typeof item.name === 'string' ? item.name.trim() : '';
        if (!source || !name || name.length > 80 || /[|\r\n<>]/.test(name)) return [];
        return [{ name, source: source.ref, label: source.label, person: item.person === true,
            level: CONTACT_LEVELS.includes(item.level) ? item.level : 'normal', selected: item.person === true }];
    });
}

export async function extractContacts(context = ctx(), settings = getSettings(), generate = request => requestBluebirdRaw(context, request, settings)) {
    if (typeof context.loadWorldInfo !== 'function') throw new Error('当前酒馆缺少世界书读取接口');
    const sources = [];
    const addSource = (source, content) => {
        const text = String(content || '');
        for (let offset = 0; offset < text.length; offset += 1800) sources.push({ ...source, content: text.slice(offset, offset + 1800) });
    };
    for (const name of storyContacts(context)) {
        const card = context.characters?.find(c => c.name?.trim() === name);
        if (card) addSource({ key: `card:${card.avatar}`, label: `角色卡：${name}`, ref: { type: 'card' }, name },
            [card.description || card.data?.description, card.personality || card.data?.personality,
                card.scenario || card.data?.scenario].filter(Boolean).join('\n'));
    }
    for (const book of boundBooks(context)) {
        const data = await context.loadWorldInfo(book);
        for (const entry of Object.values(data?.entries || {})) {
            if (!Number.isSafeInteger(Number(entry.uid)) || !String(entry.content || '').trim()) continue;
            addSource({ key: `world:${book}:${entry.uid}`, label: `${book} / ${entry.comment || entry.uid}`,
                ref: { type: 'world', book, uid: Number(entry.uid) }, name: entry.comment || '' }, entry.content);
        }
    }
    const candidates = [];
    let batch = [], length = 0;
    const flush = async () => {
        if (!batch.length) return;
        const request = { systemPrompt: '从角色卡和世界书片段中识别可私聊的人物。地名、组织、物品、抽象概念不是人物。只返回 JSON 数组，每项 {"name":"人物原名","source":"片段 key","person":true,"level":"restrained|normal|clingy"}。不确定是不是人物就写 person:false。一个片段可有多个人；禁止编造不存在的人。',
            prompt: batch.map(s => JSON.stringify({ source: s.key, title: s.label, name: s.name, content: s.content })).join('\n'), trimNames: false, responseLength: 2048, temperature: 0.2 };
        candidates.push(...parseCandidates(await generate(request), batch));
        batch = []; length = 0;
    };
    for (const source of sources) {
        if (batch.length >= 8 || length + source.content.length > 10000) await flush();
        batch.push(source); length += source.content.length;
    }
    await flush();
    const names = new Set();
    return candidates.filter(c => { const key = c.name.normalize('NFC'); if (names.has(key)) return false; names.add(key); return true; });
}
