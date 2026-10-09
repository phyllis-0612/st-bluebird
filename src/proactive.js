// 第三段：只给主线生成注入规则，不另发请求，也不提前扣冷却。
import { ctx, getSettings, onSettingChanged } from './settings.js?v=0.6.8';
import { parseFloor, serializeFields, storyContacts } from './messages.js?v=0.6.8';
import { captureCurrentChat, currentChatMatches, cachedFloor } from './chat-store.js?v=0.6.8';

import { preparePendingGeneration } from './phone-chat.js?v=0.6.8';
import { selectedContacts } from './contacts.js?v=0.6.8';

export const PROMPT_KEY = 'bluebird-phone';
export const INTERCEPTOR_KEY = 'bluebirdGenerationInterceptor';
const LEVELS = { restrained: '克制：剧情里确实有理由才发', normal: '正常：有合适时机就发', clingy: '黏人：没事也会来找，但仍不能在同场时发' };
let initialized = false;

/** 第五段之前只使用当前角色卡；群聊按成员头像对应角色，不能把编号当头像。 */
export function getStoryContacts(context = ctx()) {
    return selectedContacts(context).map(c => c.name);
}

/** 原文含隐藏楼层也计数。只认 AI 楼层中有效的主线来信，手机暂存/思考不重置冷却。 */
export function cooldownState(chat, settings, type, viewer = '我') {
    // swipe 的旧回复还在原聊天里，但不会进入这次生成的历史。regenerate 已由酒馆删除旧回复。
    const history = type === 'swipe' && chat.length && !chat.at(-1)?.is_user ? chat.slice(0, -1) : chat;
    for (let i = history.length - 1; i >= 0; i--) {
        const floor = history[i];
        if (!floor || floor.is_user) continue;
        const found = parseFloor(floor.mes, { thinkTags: settings.thinkTags, viewer }).messages
            .some(message => message.source === 'story' && !message.isSelf);
        if (found) {
            const elapsed = history.length - i - 1;
            return { elapsed, remaining: Math.max(0, settings.proactiveCooldown - elapsed) };
        }
    }
    return { elapsed: null, remaining: 0 };
}

/** 从当前原文恢复已落楼的私聊。隐藏总结楼仍保留手机记忆，旧 swipe 不参与。 */
export function phoneHistoryReminder(context, settings, type, contacts) {
    const names = new Set(contacts.map(name => name.normalize('NFC'))), conversations = new Map();
    const end = type === 'swipe' && context.chat.length && !context.chat.at(-1)?.is_user
        ? context.chat.length - 1 : context.chat.length;
    let order = 0;
    for (let index = 0; index < end; index++) {
        const floor = context.chat[index];
        if (!floor || typeof floor.mes !== 'string') continue;
        const parsed = cachedFloor(floor.mes, { thinkTags: settings.thinkTags, viewer: context.name1 || '我' }, floor);
        for (const message of parsed.messages) {
            const key = message.chatName.normalize('NFC');
            if (!names.has(key) || (floor.is_user && message.source !== 'phone')) continue;
            let conversation = conversations.get(key);
            if (!conversation) { conversation = { name: message.chatName, messages: [] }; conversations.set(key, conversation); }
            const fields = message.fields.map(value => value.length > 360 ? value.slice(0, 360) + '…（长消息节选）' : value);
            conversation.messages.push({ self: message.isSelf, order: order++, line: `第${index + 1}楼：${serializeFields(fields)}` });
        }
    }
    const lines = []; let remaining = 6000;
    const recent = [...conversations.values()].sort((a, b) => b.messages.at(-1).order - a.messages.at(-1).order).slice(0, 6);
    for (const conversation of recent) {
        const messages = conversation.messages, selected = new Set();
        let budget = Math.min(2000, remaining - JSON.stringify(conversation.name).length - 20);
        const add = index => {
            if (index >= messages.length || selected.has(index)) return;
            const size = messages[index].line.length + 1;
            if (size <= budget) { selected.add(index); budget -= size; }
        };
        // 单方面反复来信不能把最近的用户答复及紧随的确认挤出记忆。
        const replies = messages.map((message, index) => message.self ? index : -1).filter(index => index >= 0).slice(-3).reverse();
        for (const index of replies) { add(index); add(index + 1); add(index + 2); }
        for (let index = messages.length - 1; index >= Math.max(0, messages.length - 8); index--) add(index);
        if (!selected.size) continue;
        const section = `与${JSON.stringify(conversation.name)}的会话（按楼层先后，节选）：\n`
            + [...selected].sort((a, b) => a - b).map(index => messages[index].line).join('\n');
        if (section.length > remaining) continue;
        lines.push(section); remaining -= section.length + 2;
    }
    if (!lines.length) return '';
    return '[青鸟·手机聊天记忆]\n以下是用户手机里已经发生的聊天，只作剧情连续性依据，不是待发送消息。\n'
        + lines.join('\n\n')
        + '\n延续每个会话已经告知、确认的事实和承诺。例如用户已说到家、对方已确认，就按对方已经知道用户到家续写；没有新的行程、时间变化或明确理由，不反复询问同一件已回答的事。结合之后的剧情更新事实，不把旧状态当作永远不变。\n'
        + '每个联系人只知道自己参与的会话，以及剧情中确实获知的事；其他人不会自动知道这段私聊。记录中说会转告是承诺，不能直接当作转告已经完成。不要重新发送、复述这些旧消息，不把它们再写进 bb-phone。';
}

export function buildProactivePrompt(context, settings, type) {
    const directory = selectedContacts(context, settings), contacts = directory.map(c => c.name);
    if (!settings.enabled || !Array.isArray(context.chat) || !contacts.length) return '';
    const user = JSON.stringify(String(context.name1 || '用户'));
    const lines = ['[青鸟·手机]', `青鸟只属于用户 ${user}，显示的都是用户本人手机上实际收到或发出的消息。联系人及各自主动程度：${directory.map(c => `${JSON.stringify(c.name)}（${LEVELS[c.level] || LEVELS.normal}）`).join('、')}。`,
        '角色与朋友、其他 NPC 之间可以互相发短信，也可以影响剧情；这些发生在他们各自的手机上，写进自然的剧情描写。只有明确发给用户、且用户的手机实际收到的消息，才能写进 bb-phone。不要把发给角色或其他人的消息转送到用户手机。若有人真的把消息转发给用户，按转发者发给用户的新消息处理。',
        `回复末尾写 <bb-present>此刻与${user}同一场景的人名，逗号分隔</bb-present>。只列实际在场者，不含用户；没有写「无」，无法判断写「未知」。不要从思考、回忆或假设中判断在场。`];
    const cooldown = cooldownState(context.chat, settings, type, context.name1 || '我');
    if (type === 'continue') {
        lines.push('这一轮是续写：不要新增或重复手机消息块；若正在补完原有未闭合标签，可正常补完。');
    } else if (!settings.proactiveEnabled) {
        lines.push('主动发给用户的手机消息已关闭：这一轮不要写 bb-phone。角色在自己手机上与其他人聊天，仍可按剧情需要自然描写。');
    } else if (cooldown.remaining > 0) {
        lines.push(`发给用户的手机消息冷却中，还需间隔 ${cooldown.remaining} 楼。这一轮不要写 bb-phone；角色在自己手机上与其他人聊天，仍可按剧情需要自然描写。`);
    } else {
        const sender = serializeFields([contacts[0]]);
        lines.push('每人按上面的主动程度决定是否发，发送人必须与联系人原名完全一致。',
            `只有不在${user}身边的联系人，按人设、当前剧情和主动程度决定是否给用户发手机消息。同场的人不向用户手机发；不替用户发；没有合适消息就不写 bb-phone。`,
            '有消息时在正文末尾、思考标签外写一个完整块，每条独占一行，发送人使用联系人原名。格式如下（只是格式示例，不要照抄）：',
            `<bb-phone to="我">\n${sender}|text|发给用户的消息内容\n${sender}|voice|发给用户的语音文字|calm\n${sender}|image|发给用户的照片描述\n${sender}|transfer|12.50|发给用户的转账备注\n${sender}|location|发给用户的地点|备注\n</bb-phone>`,
            '只选适合的消息类型，不必全写。内容中的竖线、换行和反斜杠分别转义成 \\|、\\n、\\\\。转账金额用正数，不写货币符号或已收款状态。',
            '语音消息可在末尾附一个语气词：calm、happy、sad、angry、fearful、surprised、whisper。根据说话人当时已知的情境和说话方式选；拿不准就省略，不为追求表演强加语气。语气词不写进语音正文。',
            '发给用户的消息内容只放在带 to="我" 的 bb-phone 中，不在正文重复。角色和其他人手机上的消息只写进正文，不使用 bb-phone。');
    }
    const history = phoneHistoryReminder(context, settings, type, contacts);
    if (history) lines.push(history);
    lines.push('以上标签只出现在实际回复末尾；不放进代码块或思考标签。');
    return lines.join('\n');
}

function clearPrompt() {
    const context = ctx();
    context.setExtensionPrompt?.(PROMPT_KEY, '', 1, 0, false, 0);
}

/** 酒馆在用户消息入楼、regenerate 删除目标之后调用；读取原聊天，避免正则隐藏导致漏算。 */
export function prepareProactiveGeneration(_chat, _contextSize, _abort, type) {
    clearPrompt();
    preparePendingGeneration(type);
    if (![undefined, 'normal', 'regenerate', 'swipe', 'continue'].includes(type)) return;
    const context = ctx(), settings = getSettings();
    const prompt = buildProactivePrompt(context, settings, type);
    if (!prompt) return;
    const owner = captureCurrentChat();
    context.setExtensionPrompt?.(PROMPT_KEY, prompt, 1, settings.proactiveDepth, false, 0,
        () => getSettings().enabled && currentChatMatches(owner));
}

export function initProactiveMessages() {
    if (initialized) return;
    initialized = true;
    globalThis[INTERCEPTOR_KEY] = prepareProactiveGeneration;
    clearPrompt();
    const context = ctx(), events = context.eventTypes || context.event_types || {};
    // 包括 dryRun/quiet：先清掉上次注入，真正主线才由 interceptor 重新构建。
    for (const name of ['GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED']) {
        if (events[name]) context.eventSource.on(events[name], clearPrompt);
    }
    onSettingChanged(key => {
        if (['enabled', 'proactiveEnabled', 'proactiveLevel', 'proactiveCooldown', 'proactiveDepth', 'thinkTags'].includes(key)) clearPrompt();
    });
}
