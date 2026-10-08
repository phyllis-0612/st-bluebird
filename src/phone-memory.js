// 结绳只读适配。正式公开接口随后加入；这里不读取备份，也不写回结绳。
import { ctx, getSettings } from './settings.js?v=0.6.0';
import { maskExcluded, hidePhoneTags, serializeFields, parseFloor } from './messages.js?v=0.6.0';
import { readContactSource } from './contacts.js?v=0.6.0';

export function storyBody(text, settings) {
    const masked = hidePhoneTags(maskExcluded(String(text || ''), [...settings.thinkTags, ...settings.statusTags]));
    const tag = settings.bodyTag;
    const bodies = [...masked.matchAll(new RegExp(`<${tag}(?=[\\s/>])[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'giu'))];
    return (bodies.length ? bodies.map(m => m[1]).join('\n') : masked)
        .replace(/<\/?[\p{L}][\p{L}\p{N}_-]*(?=[\s/>])[^>]*>/giu, '').trim();
}

export function visibleStory(context, settings, hasMemory = false) {
    const floors = (context.chat || []).flatMap((floor, index) => {
        if (!floor || floor.is_system || floor.extra?.asAdvHidden) return [];
        const body = storyBody(floor.mes, settings);
        return body ? [`第${index + 1}楼 ${floor.is_user ? context.name1 || '用户' : floor.name || '剧情'}：\n${body}`] : [];
    });
    return (hasMemory ? floors : floors.slice(-settings.recentStoryCount)).join('\n\n');
}

/** 未标注楼层继承上一条在场名单；未知状态绝不视为 NPC 在场。 */
export function witnessedStory(context, settings, name) {
    let present = null;
    const floors = [];
    for (const [index, floor] of (context.chat || []).entries()) {
        if (!floor) continue;
        const parsed = parseFloor(floor.mes, { thinkTags: settings.thinkTags });
        if (parsed.present !== undefined) present = parsed.present;
        if (!present?.includes(name) || floor.is_system || floor.extra?.asAdvHidden) continue;
        const body = storyBody(floor.mes, settings);
        if (body) floors.push(`第${index + 1}楼 ${floor.is_user ? context.name1 || '用户' : floor.name || '剧情'}：\n${body}`);
    }
    return floors.slice(-settings.recentStoryCount).join('\n\n');
}

export async function readKnottedMemory(context) {
    const settings = context.extensionSettings?.autoSummaryWorldbookAdv;
    const memory = context.chatMetadata?.autoSummaryAdv_v1;
    const mode = settings?.storageMode || (memory?.segments?.length ? 'inject' : 'lorebook');
    if (mode === 'inject') {
        const segments = (Array.isArray(memory?.segments) ? memory.segments : [])
            .filter(s => typeof s?.text === 'string' && Number.isInteger(s.startFloor) && Number.isInteger(s.endFloor)
                && s.startFloor >= 0 && s.endFloor >= s.startFloor && s.endFloor < context.chat.length)
            .sort((a, b) => a.startFloor - b.startFloor);
        const ids = new Set(segments.flatMap(s => [s.layerId || `summary_${s.startFloor}_${s.endFloor}`, ...(s.sourceLayerIds || [])]));
        const thread = (Array.isArray(memory?.threadNodes) ? memory.threadNodes : [])
            .filter(n => typeof n?.text === 'string' && (ids.has(n.layerId) || String(n.layerId).startsWith('manual'))).map(n => n.text);
        return { text: [...thread, ...segments.map(s => `[${s.startFloor + 1}-${s.endFloor + 1}]\n${s.text}`)].join('\n\n'), source: '结绳记忆' };
    }
    const helper = globalThis.TavernHelper;
    const card = context.characters?.[context.characterId];
    const book = typeof helper?.getCurrentCharPrimaryLorebook === 'function'
        ? await helper.getCurrentCharPrimaryLorebook() : card?.data?.extensions?.world;
    if (!book) return { text: '', source: '未找到结绳记忆' };
    let entries;
    if (typeof helper?.getLorebookEntries === 'function') entries = await helper.getLorebookEntries(book);
    else if (typeof context.loadWorldInfo === 'function') entries = Object.values((await context.loadWorldInfo(book))?.entries || {});
    else throw new Error('当前酒馆无法读取结绳世界书，请检查酒馆或酒馆助手接口');
    const id = String(context.chatId ?? context.getCurrentChatId?.() ?? '').split(/[\\/]/).at(-1).replace(/\.jsonl?$/, '');
    if (!id) return { text: '', source: '未找到结绳记忆' };
    const prefix = `${settings?.selectedSummaryType === 'large' ? '大' : '小'}总结-${id}-`;
    const active = entries.filter(e => (e.enabled === true || (e.enabled === undefined && e.disable !== true))
        && e.comment?.startsWith(prefix) && /-\d+-\d+$/.test(e.comment)).filter(e => {
            const [, start, end] = e.comment.match(/-(\d+)-(\d+)$/);
            return Number(start) > 0 && Number(end) >= Number(start) && Number(end) <= context.chat.length;
        }).sort((a, b) => Number(a.comment.match(/-(\d+)-(\d+)$/)[2]) - Number(b.comment.match(/-(\d+)-(\d+)$/)[2]));
    return { text: active.map(e => e.content || '').filter(Boolean).join('\n\n'), source: active.length ? '结绳世界书记忆' : '未找到结绳记忆' };
}

export function phoneReplyLines(output, name, thinkTags) {
    const plain = maskExcluded(String(output || ''), thinkTags).trim();
    const block = /<bb-phone\b/i.test(plain) ? plain : `<bb-phone>\n${plain}\n</bb-phone>`;
    const parsed = parseFloor(block, { thinkTags });
    // 不替用户说话，也不接受模型擅自生成别人的消息或收款状态。
    if (parsed.skipped || !parsed.messages.length || parsed.messages.some(m => m.sender !== name || m.isSelf || m.status)) {
        throw new Error('手机回复格式不正确，消息已保留，可以重试回复');
    }
    return parsed.messages;
}

export async function buildPhoneRequest(context, contact, conversation, settings = getSettings()) {
    const card = contact.source?.type !== 'world' ? context.characters?.find(c => c.name?.trim() === contact.name) : null;
    if (!card && contact.source?.type !== 'world') throw new Error('角色卡联系人已不存在');
    const source = await readContactSource(context, contact);
    const memory = card ? await readKnottedMemory(context) : null;
    const substitute = text => String(text || '').replace(/\{\{char\}\}/gi, () => contact.name)
        .replace(/\{\{user\}\}/gi, () => context.name1 || '用户');
    const history = conversation.messages.slice(-settings.phoneHistoryCount).map(m => serializeFields(m.fields)).join('\n');
    const prompt = [
        `联系人：${contact.name}；用户：${context.name1 || '用户'}`,
        '【角色资料】\n' + substitute(source),
        ...(card ? [`【${memory.source}】\n` + substitute(memory.text || '（无）'),
            '【实际未隐藏剧情】\n' + visibleStory(context, settings, Boolean(memory.text))]
            : ['【你在场时的近期剧情】\n' + witnessedStory(context, settings, contact.name),
                '你只知道上面这些你在场时发生的事。其他剧情、未在场楼层和全局总结都不是你的记忆。']),
        '【这个会话最近的手机记录】\n' + history,
        `现在以${contact.name}的身份回复用户最新的手机消息。`,
    ].join('\n\n');
    const sender = serializeFields([contact.name]);
    const systemPrompt = `你正在扮演联系人，通过手机聊天。沿用角色人设、关系和记忆，只按角色知道的事回复，不把全局剧情当作角色亲眼所见。短、口语，不叙述动作，不替用户发言。只输出消息行，每条独占一行。格式：\n${sender}|text|内容\n${sender}|voice|语音文字\n${sender}|image|画面描述\n${sender}|transfer|正数金额|备注\n${sender}|location|地点|备注\n只选适合的类型，不照抄示例，不输出思考、代码块或解释。内容中的竖线、换行、反斜杠用 \\|、\\n、\\\\ 转义。不编造已经收款的状态。`;
    return { prompt, systemPrompt, trimNames: false, responseLength: settings.phoneReplyTokens };
}
