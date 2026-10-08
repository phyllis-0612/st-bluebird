import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFloor, buildState, splitFields, serializeFields, replaceTransferLine, hidePhoneTags } from '../src/messages.js';

const floor = (mes, id = 'floor-a') => ({ mes, extra: { bluebird: { floorId: id } }, swipe_id: 0 });

test('five message types, states, presence, and malformed lines', () => {
    const result = parseFloor(`<bb-phone>
陆知行|text|到家没
陆知行|voice|外面下雨了|温柔
陆知行|image|车窗上的雨
陆知行|transfer|200|打车钱
陆知行|location|便利店|等雨小一点
陆知行|transfer|10|accepted
陆知行|transfer|30||returned
陆知行|unknown|坏消息
陆知行|transfer|-3|坏金额
陆知行|transfer|1.234|坏金额
我|text|没有收件人
坏行
</bb-phone><bb-present>陆知行，周屿,陆知行</bb-present>`);
    assert.deepEqual(result.messages.map(m => m.type), ['text', 'voice', 'image', 'transfer', 'location', 'transfer', 'transfer']);
    assert.equal(result.messages[5].status, 'accepted');
    assert.equal(result.messages[5].note, '');
    assert.equal(result.messages[6].status, 'returned');
    assert.equal(result.skipped, 5);
    assert.deepEqual(result.present, ['陆知行', '周屿']);
});

test('escaping round-trips multiline content and literal pipes/backslashes', () => {
    const fields = ['我', 'text', '第一行\n第二行 | C:\\files\\n', '备注'];
    assert.deepEqual(splitFields(serializeFields(fields)), fields);
    assert.equal(splitFields('陆|text|未知\\x')[2], '未知\\x');
    const result = parseFloor(`<bb-phone chat="陆知行" source="phone">${serializeFields(fields.slice(0, 3))}</bb-phone>`);
    assert.equal(result.messages[0].content, fields[2]);
    assert.equal(result.messages[0].chatName, '陆知行');
});

test('thinking/code examples are excluded without changing source offsets', () => {
    const text = `😀开头\r\n<think><thinking><bb-phone>幻觉|text|别读</bb-phone></thinking></think>\r\n\`\`\`text\n<bb-phone>示例|text|别读</bb-phone>\n\`\`\`\n<bb-phone>陆知行|transfer|200|车费</bb-phone>`;
    const result = parseFloor(text);
    assert.equal(result.messages.length, 1);
    const target = result.messages[0];
    assert.equal(text.slice(target.start, target.end), target.raw);
    const f = floor(text), message = buildState([f]).conversations[0].messages[0];
    replaceTransferLine(f, message, 'accepted');
    assert.equal(f.mes, text.replace('陆知行|transfer|200|车费', '陆知行|transfer|200|车费|accepted'));
    assert.equal(parseFloor('<think>未闭合 <bb-phone>陆|text|不读</bb-phone>').messages.length, 0);
    assert.equal(parseFloor('<custom><bb-phone>陆|text|不读</bb-phone></custom>', { thinkTags: ['custom'] }).messages.length, 0);
});

test('outgoing messages route to the named recipient, multiple blocks and senders work', () => {
    const f = floor(`<bb-phone>陆|text|来了吗\n周|text|你好</bb-phone>
<bb-phone source="phone" chat="陆">我|text|在路上\n陆|text|等你</bb-phone>
<bb-phone source='phone' chat='周'>我|text|你好呀</bb-phone>`);
    const s = buildState([f]);
    assert.equal(s.conversations.length, 2);
    assert.equal(s.conversations.find(c => c.name === '陆').messages.length, 3);
    assert.equal(s.conversations.find(c => c.name === '周').messages.length, 2);
    assert.equal(s.unread, 3);
    assert.deepEqual(s.conversations.find(c => c.name === '陆').members, ['陆']);
});

test('mes is authoritative; swipe changes message set and unread identity', () => {
    const f = floor('<bb-phone>陆|text|编辑后的版本</bb-phone>');
    f.swipes = ['<bb-phone>陆|text|过时缓存</bb-phone>', '<bb-phone>周|text|另一版本</bb-phone>'];
    const original = buildState([f]);
    assert.equal(original.conversations[0].messages[0].content, '编辑后的版本');
    const id = original.conversations[0].messages[0].id;
    const seen = { 'name:陆': [id] };
    assert.equal(buildState([f], { lastSeen: seen }).unread, 0);
    f.swipe_id = 1; f.mes = f.swipes[1];
    assert.equal(buildState([f], { lastSeen: seen }).conversations[0].name, '周');
    f.mes = '<bb-phone>陆|text|编辑后的版本</bb-phone>';
    assert.equal(buildState([f], { lastSeen: seen }).unread, 1);
});

test('deleting earlier floors or inserting different lines does not lose read identity', () => {
    const empty = floor('旧正文', 'old'), f = floor('<bb-phone>陆|text|看过了</bb-phone>');
    const id = buildState([empty, f]).conversations[0].messages[0].id;
    const seen = { 'name:陆': [id] };
    assert.equal(buildState([f], { lastSeen: seen }).unread, 0);
    f.mes = '<bb-phone>陆|text|新消息\n陆|text|看过了</bb-phone>';
    const s = buildState([f], { lastSeen: seen });
    assert.equal(s.unread, 1);
    assert.equal(s.conversations[0].messages[1].id, id);
    assert.equal(buildState([]).conversations.length, 0);
});

test('identical messages are independent; transfer state changes preserve message identity', () => {
    const f = floor('<bb-phone>陆|text|嗯\n陆|text|嗯\n陆|transfer|20</bb-phone>');
    let s = buildState([f]); const messages = s.conversations[0].messages;
    assert.notEqual(messages[0].id, messages[1].id);
    const transfer = messages[2]; f.swipes = [f.mes, '备用 swipe'];
    replaceTransferLine(f, transfer, 'returned');
    assert.equal(f.swipes[0], f.mes); assert.equal(f.swipes[1], '备用 swipe');
    s = buildState([f], { lastSeen: { 'name:陆': messages.map(m => m.id) } });
    assert.equal(s.conversations[0].messages[2].id, transfer.id);
    assert.equal(s.unread, 0);
    assert.equal(s.conversations[0].messages[2].status, 'returned');
    assert.throws(() => replaceTransferLine(f, s.conversations[0].messages[2], 'accepted'));
});

test('writeback rejects stale edits, changed swipes, outgoing and non-transfer messages', () => {
    const f = floor('<bb-phone>陆|transfer|20</bb-phone>');
    const message = buildState([f]).conversations[0].messages[0];
    f.mes = '别的正文' + f.mes;
    assert.throws(() => replaceTransferLine(f, message, 'accepted'), /楼层已改变/);
    f.mes = '<bb-phone>陆|transfer|20</bb-phone>'; f.swipe_id = 1;
    assert.throws(() => replaceTransferLine(f, message, 'accepted'), /楼层已改变/);
    assert.throws(() => replaceTransferLine(f, { ...message, isSelf: true }, 'accepted'));
    assert.throws(() => replaceTransferLine(f, { ...message, type: 'text' }, 'accepted'));
});

test('presence carries forward, distinguishes unknown and explicitly nobody', () => {
    const first = floor('<bb-present>陆,周</bb-present>');
    assert.deepEqual(buildState([first, floor('没写名单')]).present, ['陆', '周']);
    assert.equal(buildState([first, floor('<bb-present>未知</bb-present>')]).present, null);
    assert.deepEqual(buildState([first, floor('<bb-present>无</bb-present>')]).present, []);
    assert.equal(buildState([floor('没写名单')]).presentFloor, null);
});

test('Knotted-hidden floors retain phone records; display stripping leaves stored text untouched', () => {
    const f = floor('正文<bb-phone>陆|text|你好</bb-phone><bb-present>无</bb-present>'); f.is_system = true;
    assert.equal(buildState([f]).conversations[0].messages.length, 1);
    const original = f.mes;
    assert.equal(hidePhoneTags(original), '正文'); assert.equal(f.mes, original);
    assert.equal(hidePhoneTags('正文<bb-phone source="phone">陆|text|半段'), '正文');
    assert.equal(hidePhoneTags('正文<bb-present>陆'), '正文');
});
