// 纯文本协议：解析保留原文偏移，不以过滤后的行号写回。
export const DEFAULT_THINK_TAGS = ['think', 'thinking', 'analysis', 'reasoning'];
const TYPES = new Set(['text', 'voice', 'image', 'transfer', 'location']);
const STATES = new Set(['accepted', 'returned']);

export function fingerprint(text) {
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) {
        a = Math.imul(a ^ text.charCodeAt(i), 16777619);
        b = Math.imul(b, 33) ^ text.charCodeAt(i);
    }
    return (a >>> 0).toString(36) + '-' + (b >>> 0).toString(36);
}

/** 屏蔽思考和代码示例，长度不变，保留原文写回位置。 */
export function maskExcluded(text, thinkTags = DEFAULT_THINK_TAGS) {
    const spans = [];
    for (const match of text.matchAll(/(^|\n)([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2\3[^\n]*(?=\n|$)|$)/g)) {
        spans.push([match.index, match.index + match[0].length]);
    }
    const tags = new Set(thinkTags.map(t => String(t).trim().toLowerCase()).filter(t => /^[a-z][a-z0-9_-]*$/.test(t)));
    let depth = 0, start = 0;
    for (const token of text.matchAll(/<\s*(\/?)\s*([a-z][a-z0-9_-]*)\b[^>]*>/gi)) {
        if (!tags.has(token[2].toLowerCase())) continue;
        if (!token[1]) { if (depth++ === 0) start = token.index; }
        else if (depth > 0 && --depth === 0) spans.push([start, token.index + token[0].length]);
    }
    if (depth) spans.push([start, text.length]);
    const chars = text.split('');
    for (const [a, b] of spans) for (let i = a; i < b; i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
    return chars.join('');
}

/** \|、\n、\r、\\；未知转义保留，不破坏路径和普通文字。 */
export function splitFields(line) {
    const result = []; let part = '';
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '|') { result.push(part.trim()); part = ''; }
        else if (c === '\\' && i + 1 < line.length) {
            const n = line[++i];
            if (n === 'u' && /^00(?:3c|3e|26)$/i.test(line.slice(i + 1, i + 5))) {
                part += String.fromCharCode(parseInt(line.slice(i + 1, i + 5), 16)); i += 4; continue;
            }
            part += n === 'n' ? '\n' : n === 'r' ? '\r' : n === '|' || n === '\\' ? n : '\\' + n;
        } else part += c;
    }
    result.push(part.trim());
    return result;
}

export function serializeFields(fields) {
    return fields.map(value => String(value).replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\|/g, '\\|')
        .replace(/</g, '\\u003c').replace(/>/g, '\\u003e')).join('|');
}

export function escapeAttribute(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\r/g, '&#13;').replace(/\n/g, '&#10;');
}

export function storyContacts(context) {
    const characters = context.characters || [];
    const group = context.groupId != null && context.groupId !== ''
        ? context.groups?.find(g => String(g.id) === String(context.groupId)) : null;
    const cards = context.groupId != null && context.groupId !== ''
        ? (group?.members || []).filter(a => !(group.disabled_members || []).includes(a)).map(a => characters.find(c => c.avatar === a))
        : [characters[context.characterId]];
    return [...new Set(cards.map(c => c?.name?.trim()).filter(Boolean))];
}

function attributes(text) {
    const attrs = {};
    for (const m of text.matchAll(/([a-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
        attrs[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4]).trim().replace(/&(quot|lt|gt|amp|#10|#13);/g,
            (_, key) => ({ quot: '"', lt: '<', gt: '>', amp: '&', '#10': '\n', '#13': '\r' })[key]);
    }
    return attrs;
}

export function parseFloor(text, { thinkTags = DEFAULT_THINK_TAGS } = {}) {
    text = typeof text === 'string' ? text : '';
    const masked = maskExcluded(text, thinkTags);
    const messages = []; let skipped = 0;
    for (const block of masked.matchAll(/<bb-phone\b([^>]*)>([\s\S]*?)<\/bb-phone\s*>/gi)) {
        const attrs = attributes(block[1]);
        const contentStart = block.index + block[0].indexOf('>') + 1;
        for (const line of block[2].matchAll(/[^\r\n]+/g)) {
            if (!line[0].trim()) continue;
            const start = contentStart + line.index;
            const raw = text.slice(start, start + line[0].length);
            const fields = splitFields(raw);
            const [sender, type, content] = fields;
            let note = fields[3] || '', status = fields[4] || '';
            if (type === 'transfer' && fields.length === 4 && STATES.has(note)) {
                status = note; note = ''; fields.splice(3, 0, '');
            }
            const isSelf = sender === '我';
            const chatName = attrs.chat || attrs.recipient || '';
            const validCount = type === 'text' || type === 'image' ? fields.length === 3
                : type === 'transfer' ? fields.length >= 3 && fields.length <= 5
                    : fields.length >= 3 && fields.length <= 4;
            if (!sender || !TYPES.has(type) || !content || !validCount
                || (isSelf && !chatName) || (type === 'transfer'
                    && (!/^\d+(?:\.\d{1,2})?$/.test(content) || !Number.isFinite(Number(content)) || Number(content) <= 0 || (status && !STATES.has(status))))) {
                skipped++; continue;
            }
            messages.push({ sender, type, content, note, status, fields, isSelf,
                chatName: chatName || sender, contactId: attrs['chat-id'] || '',
                source: attrs.source === 'phone' ? 'phone' : 'story',
                start, end: start + raw.length, raw,
                lineIndex: text.slice(0, start).split('\n').length - 1 });
        }
    }
    let present;
    for (const block of masked.matchAll(/<bb-present\b[^>]*>([\s\S]*?)<\/bb-present\s*>/gi)) {
        const value = block[1].trim();
        present = !value || value === '未知' ? null : value === '无' ? []
            : [...new Set(value.split(/[,，、\n]/).map(s => s.trim()).filter(Boolean))];
    }
    return { messages, present, skipped };
}

export function activeSwipe(floor) {
    return Number.isInteger(floor?.swipe_id) && floor.swipe_id >= 0 ? floor.swipe_id : 0;
}

export function activeSwipeKey(floor) {
    return floor.extra?.bluebird?.swipeId || String(activeSwipe(floor));
}

/** mes 是当前正在显示的版本；swipes 可能尚未同步编辑结果，不能反过来覆盖 mes。 */
export function buildState(chat, { thinkTags = DEFAULT_THINK_TAGS, lastSeen = {} } = {}) {
    const conversations = new Map(), floors = new Map(), byId = new Map(), seenSets = new Map();
    let present = null, presentFloor = null, skipped = 0, order = 0;
    for (let floorIndex = 0; floorIndex < chat.length; floorIndex++) {
        const floor = chat[floorIndex];
        if (!floor) continue;
        const parsed = parseFloor(floor.mes, { thinkTags });
        skipped += parsed.skipped;
        if (parsed.present !== undefined) { present = parsed.present; presentFloor = floorIndex; }
        const occurrences = new Map();
        const floorId = floor.extra?.bluebird?.floorId || `legacy-${fingerprint(String(floor.send_date) + ':' + floorIndex)}`;
        const floorMessages = [];
        for (const item of parsed.messages) {
            const conversationId = item.contactId ? `contact:${item.contactId}` : `name:${item.chatName.normalize('NFC')}`;
            // 状态改变不制造一条新消息；不同 swipe 独立记已读。
            const signature = fingerprint(JSON.stringify([conversationId, item.sender, item.type, item.content, item.note, item.source]));
            const occurrence = occurrences.get(signature) || 0;
            occurrences.set(signature, occurrence + 1);
            const id = `${floorId}:${activeSwipeKey(floor)}:${signature}:${occurrence}`;
            if (!seenSets.has(conversationId)) seenSets.set(conversationId, new Set(Array.isArray(lastSeen[conversationId]) ? lastSeen[conversationId] : []));
            const message = { ...item, id, conversationId, floorIndex, floorId,
                floorRef: floor, swipe: activeSwipe(floor), variantId: activeSwipeKey(floor), order: order++,
                unread: !item.isSelf && !seenSets.get(conversationId).has(id) };
            let conversation = conversations.get(conversationId);
            if (!conversation) {
                conversation = { id: conversationId, name: item.chatName, members: item.isSelf ? [item.chatName] : [], messages: [], unread: 0 };
                conversations.set(conversationId, conversation);
            }
            if (!item.isSelf && !conversation.members.includes(item.sender)) conversation.members.push(item.sender);
            conversation.messages.push(message);
            conversation.unread += Number(message.unread);
            conversation.lastOrder = message.order;
            floorMessages.push(message); byId.set(id, message);
        }
        if (floorMessages.length) floors.set(floorIndex, floorMessages);
    }
    const list = [...conversations.values()].sort((a, b) => b.lastOrder - a.lastOrder);
    return { conversations: list, floors, byId, present, presentFloor, skipped,
        unread: list.reduce((n, c) => n + c.unread, 0) };
}

/** 单次、精确写回。拒绝已切换 swipe、已编辑的目标，或重复处理转账。 */
export function replaceTransferLine(floor, message, status) {
    if (!STATES.has(status) || message.type !== 'transfer' || message.isSelf || message.status) throw new Error('这笔转账已经处理，或不支持此操作');
    if (activeSwipe(floor) !== message.swipe || activeSwipeKey(floor) !== message.variantId
        || floor.mes.slice(message.start, message.end) !== message.raw) throw new Error('楼层已改变，请重新打开这笔转账');
    const fields = [...message.fields];
    while (fields.length < 4) fields.push('');
    fields[4] = status;
    const mes = floor.mes.slice(0, message.start) + serializeFields(fields) + floor.mes.slice(message.end);
    floor.mes = mes;
    if (Array.isArray(floor.swipes) && typeof floor.swipes[message.swipe] === 'string') floor.swipes[message.swipe] = mes;
    return mes;
}

/** 只改变显示文本，不改变存档；未闭合的流式标签也不泄漏原始消息。 */
export function hidePhoneTags(text) {
    return String(text).replace(/<bb-phone\b[^>]*>[\s\S]*?(?:<\/bb-phone\s*>|$)/gi, '')
        .replace(/<bb-present\b[^>]*>[\s\S]*?(?:<\/bb-present\s*>|$)/gi, '');
}
