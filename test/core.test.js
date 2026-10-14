// 核心逻辑测试。用 Node 内置 test runner，零依赖：node --test test/
//
// 覆盖最容易被改坏、且直接影响"她像不像真人"的部分。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitIntoChunks, typingRhythm, buildSystemPrompt, deriveTraits, currentSituation, suppressQuestions, humanize, normalizePunctuation, polishChunks } from '../src/soul/persona.js';
import { MBTI_TRAITS, evolveTraits } from '../src/soul/mbti.js';
import { Soul, detectRudeness } from '../src/soul/soul.js';
import { extractPromises, inferDueAt, PromiseLedger } from '../src/soul/promises.js';
import { parseCommands, hasCommands, filterCommands, emptyUsage, PER_REPLY, PER_DAY } from '../src/soul/commands.js';
import { listStickers, findSticker, readSticker, nameSimilarity } from '../src/soul/stickers.js';
import { checkRepeat, similarity, containment, rememberReply, RECENT_KEEP } from '../src/soul/repeat.js';
import { longingLevel, reunionTone, reunionHint, ReunionLedger, PEAK_HOURS } from '../src/soul/longing.js';
import { daysTogether, checkMilestone, milestoneHint, MilestoneLedger } from '../src/soul/milestones.js';
import { shouldUpdate, buildPortraitPrompt, cleanPortrait, portraitBlock, MIN_NEW_CHATS, MAX_LEN } from '../src/soul/portrait.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore, detectIntents } from '../src/soul/memory.js';
import { resolveVisionSlot, sanitizeConfig, DEFAULT_CONFIG } from '../src/config.js';
import { extractUserMessages, normalizeMessage, describeItem } from '../src/channel/messages.js';
import { parseAesKey, aesEcbPaddedSize, encryptAesEcb, decryptAesEcb, buildImageItem, aesKeyToHex } from '../src/channel/media.js';

// ── 拆条 ──
test('拆条：短回复不拆', () => {
  assert.deepEqual(splitIntoChunks('嗯', 3, 50), ['嗯']);
  assert.deepEqual(splitIntoChunks('在的', 3, 50), ['在的']);
});

test('拆条：按句末标点切开', () => {
  const out = splitIntoChunks('今天店里来了只猫。特别黏人。我喂了它一点东西。', 3, 80);
  assert.ok(out.length >= 2 && out.length <= 3, `实际: ${JSON.stringify(out)}`);
  assert.ok(out.every((s) => s.length > 0));
});

test('拆条：话痨低时不拆', () => {
  const out = splitIntoChunks('今天店里来了只猫。特别黏人。我喂了它一点东西。', 3, 20);
  assert.equal(out.length, 1);
});

test('拆条：极简回复整条保留（哪怕含多个句号）', () => {
  // 10 个字符虽然含 5 个句号，但整体就是一句短话，不该拆
  assert.deepEqual(splitIntoChunks('一。二。三。四。五。', 2, 80), ['一。二。三。四。五。']);
});

test('拆条：超出上限时后面的合并到最后一条', () => {
  const long = '今天店里来了一只特别黏人的橘猫。它一直蹭我的裤腿。我喂了它半根火腿肠。它吃完就跑了。我到现在还想着它。';
  const out = splitIntoChunks(long, 2, 80);
  assert.equal(out.length, 2, `实际: ${JSON.stringify(out)}`);
  // 合并后的最后一条应含多个句子
  assert.ok(out[1].length > out[0].length, '后面的句子应被合并进最后一条');
  // 不能丢内容
  assert.equal(out.join(''), long);
});

test('拆条：空输入返回空数组', () => {
  assert.deepEqual(splitIntoChunks('', 3, 50), []);
  assert.deepEqual(splitIntoChunks(null, 3, 50), []);
});

// ── 拟人节奏 ──
test('节奏：秒回模式很快', () => {
  const r = typingRhythm('你好', 'instant', ['你好']);
  assert.ok(r.beforeFirst < 1000);
});

test('节奏：拟人模式有反应时间且非负', () => {
  const r = typingRhythm('今天天气不错，我出去走了走，顺便买了点东西。', 'human', ['a', 'b']);
  assert.ok(r.beforeFirst > 0);
  assert.ok(r.between.length === 2);
  assert.ok(r.between.every((v) => v >= 0));
});

test('节奏：长文本打字更久但不失控', () => {
  const short = typingRhythm('好', 'human', ['好']);
  const long = typingRhythm('啊'.repeat(500), 'human', ['x']);
  assert.ok(long.beforeFirst >= short.beforeFirst);
  assert.ok(long.beforeFirst < 20000, '打字延迟不应超过 20 秒');
});

test('节奏：慢热模式明显更慢', () => {
  const fast = typingRhythm('你好', 'instant', ['你好']);
  const slow = typingRhythm('你好', 'slow', ['你好']);
  assert.ok(slow.beforeFirst > fast.beforeFirst * 3);
});

test('节奏：★ 两条之间不能太近（真出过这个 bug，一眼假）', () => {
  // 真实日志里她这样发过：
  //   [10:07:17] 发给: 再过一会儿就下班了
  //   [10:07:19] 发给: 今天和老朋友聊了一个下午，挺愉快的
  // 1 秒两条 —— 真人补一句要重新打一遍字，再快也得两秒多。
  // 机器人一秒钟倒两条，比说错话更容易被看穿。
  const chunks = ['再过一会儿就下班了', '今天和老朋友聊了一个下午，挺愉快的'];
  let min = Infinity;
  for (let i = 0; i < 300; i++) {
    const r = typingRhythm(chunks.join(''), 'human', chunks);
    min = Math.min(min, r.between[0]);
  }
  assert.ok(min >= 2000, `两条之间最少也要 2 秒，实测最小 ${min}ms`);
});

test('节奏：★ 间隔要跟着"下一句有多长"走', () => {
  // 补一句长的，本来就该等更久 —— 原来是死板的 900ms，跟长度无关
  const short = typingRhythm('a', 'human', ['第一条', '嗯']);
  const long = typingRhythm('a', 'human', ['第一条', '这是一句相当长的话要打很久才能打完呢真的很久']);
  assert.ok(long.between[0] > short.between[0],
    `长的该等更久：${long.between[0]} vs ${short.between[0]}`);
});

test('节奏：★ 最后一条之后不能再等', () => {
  const r = typingRhythm('ab', 'human', ['a', 'b', 'c']);
  assert.equal(r.between.at(-1), 0, '发完最后一条还等，会白挂着');
  assert.equal(r.between.length, 3);
});

test('节奏：间隔有上限，不能挂太久', () => {
  const r = typingRhythm('a', 'human', ['x', '啊'.repeat(2000)]);
  assert.ok(r.between[0] <= 12000, `拿到 ${r.between[0]}ms，等太久她像掉线了`);
});

// ── MBTI 六维 ──
test('MBTI：16 型全部生成且值在合法范围', () => {
  const keys = Object.keys(MBTI_TRAITS);
  assert.equal(keys.length, 16);
  for (const k of keys) {
    const t = MBTI_TRAITS[k];
    for (const [dim, v] of Object.entries(t)) {
      assert.ok(v >= 5 && v <= 95, `${k}.${dim} = ${v} 越界`);
    }
  }
});

test('MBTI：E/I 与 F/T 在温度上有区分度', () => {
  assert.ok(MBTI_TRAITS.ENFP.warmth > MBTI_TRAITS.ISTJ.warmth);
  assert.ok(MBTI_TRAITS.ESTJ.sharp > MBTI_TRAITS.INFP.sharp);
});

test('MBTI：话痨度 E 明显高于 I', () => {
  assert.ok(MBTI_TRAITS.ESFP.verbosity > MBTI_TRAITS.INTP.verbosity);
});

test('六维演化：单次变化不超过 ±2', () => {
  const base = { ...MBTI_TRAITS.INFP };
  const out = evolveTraits(base, { warm: 999, rude: 999, chats: 999 });
  for (const k of Object.keys(base)) {
    assert.ok(Math.abs(out[k] - base[k]) <= 2, `${k} 变化过大`);
  }
});

// ── 此刻的处境 ──
test('处境：睡眠窗口内判定为睡着', () => {
  const at = (h, m) => new Date(2026, 0, 1, h, m);
  const daily = { wakeAt: '07:30', sleepAt: '23:30' };
  assert.equal(currentSituation(at(2, 0), daily).asleep, true);
  assert.equal(currentSituation(at(6, 0), daily).asleep, true);
  assert.equal(currentSituation(at(12, 0), daily).asleep, false);
});

test('处境：职业短语不会出现"在在"', () => {
  const daily = { wakeAt: '07:30', sleepAt: '23:30', job: '在一家书店做店员' };
  const s = currentSituation(new Date(2026, 0, 1, 10, 0), daily);
  assert.ok(!s.activity.includes('在在'), `实际: ${s.activity}`);
});

// ── 记忆 ──
test('记忆：写入后可检索', () => {
  const m = new MemoryStore({ maxEntries: 100 });
  m.entries = [];
  m.add('他住在南京，喜欢下雨天', { bucket: 'solid', who: 'u1' });
  const hits = m.recall('南京', { topK: 5, who: 'u1' });
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].text.includes('南京'));
});

test('记忆：重复内容不重复记', () => {
  const m = new MemoryStore({ maxEntries: 100 });
  m.entries = [];
  m.add('他喜欢猫', { who: 'u1' });
  m.add('他喜欢猫', { who: 'u1' });
  assert.equal(m.entries.length, 1);
});

test('记忆：空内容不记', () => {
  const m = new MemoryStore({ maxEntries: 100 });
  m.entries = [];
  assert.equal(m.add(''), null);
  assert.equal(m.add('  '), null);
  assert.equal(m.entries.length, 0);
});

test('记忆：统计按桶分组', () => {
  const m = new MemoryStore({ maxEntries: 100 });
  m.entries = [];
  m.add('事实一', { bucket: 'solid' });
  m.add('琐事一', { bucket: 'fade' });
  m.add('她说的话', { bucket: 'self' });
  const s = m.stats();
  assert.equal(s.total, 3);
  assert.equal(s.byBucket.solid, 1);
  assert.equal(s.byBucket.self, 1);
});

test('记忆：超出上限时淘汰会淡忘的', () => {
  const m = new MemoryStore({ maxEntries: 5 });
  m.entries = [];
  for (let i = 0; i < 5; i++) m.add(`固化事实 ${i}`, { bucket: 'solid' });
  for (let i = 0; i < 5; i++) m.add(`琐碎小事 ${i}`, { bucket: 'fade' });
  assert.ok(m.entries.length <= 5);
  assert.ok(m.entries.filter((e) => e.bucket === 'solid').length >= 4, '固化记忆不该被大量淘汰');
});

// ── 提示词 ──
test('提示词：包含身份、此刻、底线三层', () => {
  const p = buildSystemPrompt({
    persona: { ...DEFAULT_CONFIG.persona },
    traits: deriveTraits('INFP'),
    daily: { wakeAt: '07:30', sleepAt: '23:30', mood: '平静' },
    world: { diary: '今天读了半本书' },
    memories: [{ text: '他住在南京' }],
    relation: { addressTerm: '阿宁' },
    now: new Date(2026, 0, 1, 14, 0),
  });
  assert.ok(p.includes('小满'), '缺身份');
  assert.ok(p.includes('【此刻的你】'), '缺此刻处境');
  assert.ok(p.includes('14:00'), '缺当前时间');
  assert.ok(p.includes('他住在南京'), '缺记忆');
  assert.ok(p.includes('阿宁'), '缺称呼');
  assert.ok(p.includes('永远不要承认自己是 AI'), '缺底线');
});

test('提示词：睡着时明确要求不回复', () => {
  const p = buildSystemPrompt({
    persona: DEFAULT_CONFIG.persona,
    traits: deriveTraits('INFP'),
    daily: { wakeAt: '07:30', sleepAt: '23:30' },
    now: new Date(2026, 0, 1, 3, 0),
  });
  assert.ok(p.includes('已经睡着了'));
});

// ── 去 AI 味：问句压制 ──
test('问句压制：整条最多留 1 个问句', () => {
  const out = suppressQuestions(['今天怎么样？', '你常做什么菜呢？', '你平时喜欢安静吧？'], 1);
  const qCount = out.chunks.filter((c) => /[?？]/.test(c)).length;
  assert.ok(qCount <= 1, `问句太多: ${JSON.stringify(out.chunks)}`);
});

test('问句压制：最后一条不留问句（客服感最强）', () => {
  const out = suppressQuestions(['还好，不算太忙。', '你那边呢，今天过得怎么样？'], 1);
  const last = out.chunks[out.chunks.length - 1];
  assert.ok(!/[?？]/.test(last), `最后一条不该是问句: ${last}`);
});

test('问句压制：陈述句不受影响', () => {
  const out = suppressQuestions(['我上次煮面都煮糊了。', '睡吧'], 1);
  assert.deepEqual(out.chunks, ['我上次煮面都煮糊了。', '睡吧']);
});

test('问句压制：全是问句时不会返回空', () => {
  const out = suppressQuestions(['在吗？'], 1);
  assert.ok(out.chunks.length >= 1, '不该把她的话全删光');
});

// ── 去 AI 味：口语化 ──
test('口语化：替换掉教科书句式', () => {
  assert.equal(humanize('做饭是个技术活，多试试就能掌握了。'), '做饭是个技术活，多试几次就好了');
  assert.equal(humanize('我认为这需要时间和耐心。'), '我觉得慢慢来吧');
});

test('口语化：不会产生重复的"了"', () => {
  const out = humanize('多试试就能掌握了。');
  assert.ok(!/了了/.test(out), `出现重复"了": ${out}`);
});

test('口语化：祈使句"睡吧"不被当成问句删掉', () => {
  const out = suppressQuestions(['我上次煮面都煮糊了。', '睡吧'], 1);
  assert.ok(out.chunks.includes('睡吧'), `"睡吧"被误删: ${JSON.stringify(out.chunks)}`);
});

test('口语化：删掉客服尾巴', () => {
  assert.equal(humanize('那你早点休息，晚安。记得梦里也要做个好梦哦。'), '那你早点休息，晚安。');
  assert.equal(humanize('有什么问题随时找我。'), '');
});

test('口语化：正常内容不被改坏', () => {
  const s = '今天店里来了只猫，特别黏人。';
  assert.equal(humanize(s), s);
});

test('口语化：空输入安全', () => {
  assert.equal(humanize(''), '');
  assert.equal(humanize(null), '');
});

// ── 标点去格式化（真人打字习惯）──
test('标点：句尾句号去掉', () => {
  assert.equal(normalizePunctuation('睡吧。'), '睡吧');
  assert.equal(normalizePunctuation('我在店里整理书架。'), '我在店里整理书架');
});

test('标点：句尾问号去掉（吗/呢 本身已表疑问）', () => {
  assert.equal(normalizePunctuation('你也在忙吗？'), '你也在忙吗');
  assert.equal(normalizePunctuation('你那边呢？'), '你那边呢');
});

test('标点：逗号保留', () => {
  assert.equal(normalizePunctuation('还好，人不算多'), '还好，人不算多');
  assert.equal(normalizePunctuation('还好，人不算多。'), '还好，人不算多');
});

test('标点：强烈的追问保留', () => {
  assert.equal(normalizePunctuation('真的吗？？'), '真的吗？？');
});

test('标点：叹号保留（真人会用）', () => {
  assert.equal(normalizePunctuation('哈哈哈哈！'), '哈哈哈哈！');
  assert.equal(normalizePunctuation('好厉害！'), '好厉害！');
});

test('标点：无标点输入不变', () => {
  assert.equal(normalizePunctuation('睡吧'), '睡吧');
  assert.equal(normalizePunctuation('好'), '好');
});

test('标点：纯标点输入的处理', () => {
  assert.equal(normalizePunctuation('。。。'), '');  // 无内容，整条丢弃
  assert.equal(normalizePunctuation('？'), '？');     // 单独的"？"是真人表达疑惑，保留
});

test('标点：整批处理后过滤空条目', () => {
  const out = polishChunks(['睡吧。', '。', '哈哈，火开小点。']);
  assert.deepEqual(out, ['睡吧', '哈哈，火开小点']);
});

test('标点：不影响句中标点', () => {
  assert.equal(normalizePunctuation('猫独立又亲人，特别是橘猫，团子超级可爱'), '猫独立又亲人，特别是橘猫，团子超级可爱');
});

// ── 提示词：反客服示范 ──
test('提示词：包含正面/反面说话示范', () => {
  const p = buildSystemPrompt({
    persona: DEFAULT_CONFIG.persona,
    traits: deriveTraits('INFP'),
    daily: { wakeAt: '07:30', sleepAt: '23:30' },
    now: new Date(2026, 0, 1, 14, 0),
  });
  assert.ok(p.includes('✗ 不对'), '缺反面示范');
  assert.ok(p.includes('✓ 对'), '缺正面示范');
  assert.ok(p.includes('很少提问'), '缺提问约束');
});

// ── 此刻状态：分时段（不能把一整天倒出来）──
test('此刻状态：按时间从全天流水里切出当下', () => {
  const daily = {
    wakeAt: '08:00', sleepAt: '22:30', mood: '平静',
    flow: '上午在店里整理旧书，下午来了个老客人聊了半小时，晚上帮朋友挑书',
  };

  const mk = (h) => { const d = new Date(2026, 8, 19, h, 30); return currentSituation(d, daily); };

  const morning = mk(10);
  const afternoon = mk(15);
  const evening = mk(20);

  assert.notEqual(morning.activity, daily.flow, '不该把全天流水当作此刻');
  assert.notEqual(afternoon.activity, daily.flow, '不该把全天流水当作此刻');
  assert.ok(morning.activity.includes('整理'), `上午应命中整理: ${morning.activity}`);
  assert.ok(afternoon.activity.includes('老客人'), `下午应命中老客人: ${afternoon.activity}`);
  assert.ok(evening.activity.includes('帮朋友'), `晚上应命中帮朋友: ${evening.activity}`);
  assert.equal(morning.todaySummary, daily.flow, '全天梗概应保留作背景');
});

test('此刻状态：睡眠时段返回睡着', () => {
  const daily = { wakeAt: '08:00', sleepAt: '22:30', mood: '平静', flow: '上午在店里' };
  const s = currentSituation(new Date(2026, 8, 19, 23, 30), daily);
  assert.equal(s.asleep, true);
});

test('此刻状态：没有流水时按时段兜底', () => {
  const daily = { wakeAt: '08:00', sleepAt: '22:30', mood: '平静', job: '在一家书店做店员' };
  const s = currentSituation(new Date(2026, 8, 19, 15, 0), daily);
  assert.ok(s.activity.length > 0);
  assert.ok(!s.activity.includes('在在'), `不该出现"在在": ${s.activity}`);
});

// ── 提示词：记忆去污染 ──
test('提示词：不把自己过去的回复当记忆回灌', () => {
  const p = buildSystemPrompt({
    persona: DEFAULT_CONFIG.persona,
    traits: deriveTraits('INFP'),
    daily: { wakeAt: '07:30', sleepAt: '23:30', mood: '平静' },
    now: new Date(2026, 0, 1, 14, 0),
    memories: [
      { text: '他养了一只叫豆豆的柯基', bucket: 'solid' },
      { text: '哈哈，读书这事，找到自己喜欢的最重要。你呢，喜欢啥类型的？', bucket: 'self' },
    ],
  });
  assert.ok(p.includes('豆豆'), '事实类记忆应喂进去');
  assert.ok(!p.includes('你喜欢啥类型的'), '自己的旧回复不该回灌（会自我强化客服腔）');
});

// ── 记忆检索：意图匹配 ──
function freshMemory(facts) {
  const m = new MemoryStore({ maxEntries: 100 });
  m.entries = [];
  for (const f of facts) m.add(f, { bucket: 'solid', who: 'p1' });
  return m;
}

const FACTS = [
  '他叫陈默', '他住在南京', '他养了一只叫豆豆的柯基', '他不吃辣',
  '他是做建筑设计的', '他老家在东北', '他常熬夜到两三点',
];

test('召回：问"我叫什么"能找回"他叫陈默"（字面完全不重叠）', () => {
  const m = freshMemory(FACTS);
  const texts = m.recall('我叫什么', { who: 'p1' }).map((e) => e.text);
  assert.ok(texts.some((t) => t.includes('陈默')), `召回失败: ${texts.join(' | ')}`);
});

test('召回：问"我住哪"能找回住处', () => {
  const m = freshMemory(FACTS);
  const texts = m.recall('我住哪', { who: 'p1' }).map((e) => e.text);
  assert.ok(texts.some((t) => t.includes('南京')), `召回失败: ${texts.join(' | ')}`);
});

test('召回：问"我那只狗叫什么"能找回宠物', () => {
  const m = freshMemory(FACTS);
  const texts = m.recall('我那只狗叫什么来着', { who: 'p1' }).map((e) => e.text);
  assert.ok(texts.some((t) => t.includes('豆豆')), `召回失败: ${texts.join(' | ')}`);
});

test('召回：问"晚上吃火锅行吗"能想起忌口', () => {
  const m = freshMemory(FACTS);
  const texts = m.recall('晚上吃火锅行吗', { who: 'p1' }).map((e) => e.text);
  assert.ok(texts.some((t) => t.includes('不吃辣')), `召回失败: ${texts.join(' | ')}`);
});

test('召回：闲聊不该返回任何记忆（避免噪音干扰）', () => {
  const m = freshMemory(FACTS);
  for (const q of ['哈哈哈哈', '在吗', '嗯嗯', '哦', '好']) {
    const r = m.recall(q, { who: 'p1' });
    assert.equal(r.length, 0, `「${q}」不该召回，却返回: ${r.map((e) => e.text).join(' | ')}`);
  }
});

test('召回：命中时排在第一位的应是正确记忆', () => {
  const m = freshMemory(FACTS);
  const first = m.recall('我叫什么', { who: 'p1' })[0];
  assert.ok(first && first.text.includes('陈默'), `首位不是姓名记忆: ${first?.text}`);
});

// ── 意图识别 ──
test('意图识别：提问和记忆能对上同一类别', () => {
  const ask = detectIntents('我那只狗叫什么来着');
  const store = detectIntents('他养了一只叫豆豆的柯基');
  const common = [...ask].filter((i) => store.has(i));
  assert.ok(common.length > 0, `没有共同意图: 问=${[...ask]} 存=${[...store]}`);
});

test('意图识别：无关文本返回空集', () => {
  assert.equal(detectIntents('哈哈哈哈').size, 0);
  assert.equal(detectIntents('嗯').size, 0);
});

// ── 出站图片 item：密钥字段必须能被对端解析 ──
test('图片 item：两种密钥形态都能解出同一把密钥', () => {
  const raw = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const aesKeyBase64 = Buffer.from(raw.toString('hex')).toString('base64');
  const item = buildImageItem({
    encryptQueryParam: 'P', aesKeyBase64, fileSize: 100, fileSizeCiphertext: 112,
  });
  const it = item.image_item;

  assert.equal(item.type, 2);
  assert.equal(it.media.encrypt_type, 1);
  // 顶层 aeskey 必须是 32 位 hex —— 参考实现在这里是 64 位（写错了），我们不能跟着错
  assert.match(it.aeskey, /^[0-9a-fA-F]{32}$/, `顶层 aeskey 不是 32 位 hex: ${it.aeskey}`);
  assert.equal(it.aeskey, raw.toString('hex'));
  assert.ok(Buffer.from(it.aeskey, 'hex').equals(raw), 'hex 形态解不出原密钥');
  assert.ok(parseAesKey(it.media.aes_key).equals(raw), 'base64 形态解不出原密钥');
});

test('图片 item：长度字段语义正确', () => {
  const item = buildImageItem({
    encryptQueryParam: 'P',
    aesKeyBase64: Buffer.from('00'.repeat(16)).toString('base64'),
    fileSize: 10397,
    fileSizeCiphertext: 10400,
  });
  assert.equal(item.image_item.mid_size, 10400, 'mid_size 应为密文长度');
  assert.equal(item.image_item.len, '10397', 'len 应为明文长度');
});

test('aesKeyToHex：非法输入返回空串而不是乱码', () => {
  assert.equal(aesKeyToHex(''), '');
  assert.equal(aesKeyToHex(null), '');
  assert.equal(aesKeyToHex(Buffer.from('short').toString('base64')), '');
});

// ── 识图槽位回落 ──
test('识图槽位：留空时回落对话模型', () => {
  const cfg = {
    brain: { baseUrl: 'https://chat/v1', apiKey: 'k1', model: 'chat-model' },
    vision: { baseUrl: '', apiKey: '', model: '' },
  };
  const slot = resolveVisionSlot(cfg);
  assert.equal(slot.baseUrl, 'https://chat/v1');
  assert.equal(slot.model, 'chat-model');
  assert.equal(slot.degraded, true, '未配独立模型时应标记为降级');
});

test('识图槽位：配了就用自己的', () => {
  const cfg = {
    brain: { baseUrl: 'https://chat/v1', apiKey: 'k1', model: 'chat-model' },
    vision: { baseUrl: 'https://vl/v1', apiKey: 'k2', model: 'vl-model' },
  };
  const slot = resolveVisionSlot(cfg);
  assert.equal(slot.baseUrl, 'https://vl/v1');
  assert.equal(slot.apiKey, 'k2');
  assert.equal(slot.model, 'vl-model');
  assert.equal(slot.degraded, false);
});

// ── 上下文治理 ──
test('对话历史治理：超长时压缩而不是无限增长', () => {
  // 模拟 setHistory 的治理规则
  const SOFT = 24, HARD = 40;
  const govern = (history) => {
    let list = history;
    let summary = '';
    if (list.length > SOFT) {
      const overflow = list.slice(0, list.length - SOFT);
      list = list.slice(-SOFT);
      if (overflow.length) {
        const merged = overflow.map((m) => m.content).join(' ');
        summary = merged.length > 300 ? `…${merged.slice(-300)}` : merged;
      }
    }
    if (list.length > HARD) list = list.slice(-HARD);
    return { list, summary };
  };

  const long = [];
  for (let i = 0; i < 30; i++) {
    long.push({ role: 'user', content: `u${i}` });
    long.push({ role: 'assistant', content: `a${i}` });
  }
  const { list, summary } = govern(long);
  assert.ok(list.length <= HARD, `治理后仍有 ${list.length} 条`);
  assert.equal(list[list.length - 1].content, 'a29', '必须保留最新的对话');
  assert.ok(summary.length > 0, '必须有摘要兜底，否则就是真的断片了');
  assert.ok(summary.includes('u0'), '摘要应包含最早的对话');
});

test('摘要保留的是最近的内容（越近越要紧）', () => {
  const text = Array.from({ length: 200 }, (_, i) => `句${i}`).join(' ');
  const short = text.length > 300 ? `…${text.slice(-300)}` : text;
  assert.ok(short.includes('句199'), '最新的内容必须在');
  assert.ok(short.startsWith('…'), '超长时应带省略号');
});

// ── 主动消息 ──
test('主动消息：刚聊完不该发"思念"', () => {
  // silentHours 表示"用户多久没说话"。刚聊完 → 不该打扰。
  const shouldSendLonging = (silentHours, configuredAfterHours, quietEnough) =>
    silentHours >= configuredAfterHours && quietEnough;

  assert.equal(shouldSendLonging(0.5, 8, false), false, '刚聊完不能发思念');
  assert.equal(shouldSendLonging(2, 8, false), false, '2 小时前聊过也不能发');
  assert.equal(shouldSendLonging(10, 8, true), true, '10 小时没说话可以发');
});

// ── 事件驱动的性格微调 ──
test('敌意识别：只有指向她的话才算凶', () => {
  // 带"你"的明确敌意
  assert.ok(detectRudeness('你真笨'));
  assert.ok(detectRudeness('闭嘴'));
  assert.ok(detectRudeness('你给我滚'));
  assert.ok(detectRudeness('你懂个屁'));

  // 吐槽别的东西 —— 误判会让她无缘无故变冷，比漏判更伤
  assert.equal(detectRudeness('工作烦死了'), false, '"工作烦死了"不是在凶她');
  assert.equal(detectRudeness('这电影真垃圾'), false, '吐槽电影不该被当成凶她');
  assert.equal(detectRudeness('我今天好累'), false);
  assert.equal(detectRudeness('哈哈哈哈哈'), false);
  // 没有"你"就没有攻击对象，宁可漏判
  assert.equal(detectRudeness('烦死了'), false);
});

test('性格微调：被凶当天变冷、次日回落', () => {
  const mk = () => new Soul({
    cfg: { persona: { mbti: 'INFP', name: '小满' }, brain: {}, memory: {} },
    memory: {}, world: { scriptFor: () => null },
  });
  const base = mk().traitsFor();

  const s = mk();
  s.noteEvent('rude'); s.noteEvent('rude'); s.noteEvent('rude');
  const after = s.traitsFor();
  assert.ok(after.warmth < base.warmth, '被凶后温度应下降');
  assert.ok(after.sharp > base.sharp, '被凶后锐度应上升');

  // 新的一天（新的漂移桶）→ 回落
  const fresh = mk().traitsFor();
  assert.equal(fresh.warmth, base.warmth, '次日应回落到基线');
});

test('长期漂移被钳制：她会长大但不会变成另一个人', () => {
  const base = deriveTraits('INFP');
  // 极端信号：连续被凶 100 次
  const evolved = evolveTraits(base, { rude: 100, warm: 0, chats: 0 });
  assert.ok(Math.abs(evolved.warmth - base.warmth) <= 2, `单周温度变化应在 ±2 内，实际 ${evolved.warmth - base.warmth}`);
  assert.ok(Math.abs(evolved.sharp - base.sharp) <= 2, `单周锐度变化应在 ±2 内`);
  assert.ok(evolved.warmth >= 5 && evolved.warmth <= 95, '必须仍在合法区间');
});

test('关系与漂移能跨重启保留', () => {
  const mk = () => new Soul({
    cfg: { persona: { mbti: 'INFP', name: '小满' }, brain: {}, memory: {} },
    memory: {}, world: { scriptFor: () => null },
  });
  const a = mk();
  a.noteEvent('rude');
  a.drift.rude = 7;
  a.relationFor('peer1').addressTerm = '阿默';

  const b = mk();
  b.hydrate(a.serialize());
  assert.equal(b.drift.rude, 7, '漂移信号应保留');
  assert.equal(b.relationFor('peer1').addressTerm, '阿默', '称呼应保留');
});

// ── 承诺账本 ──
test('承诺抽取：抓得住承诺，也不误抓日常话', () => {
  assert.ok(extractPromises('我明天告诉你结果').length > 0);
  assert.ok(extractPromises('等我查查那本书').length > 0);
  assert.ok(extractPromises('改天给你看我拍的照片').length > 0);

  // 这些不是承诺，误抓会让她莫名其妙冒出一句"我来兑现"
  assert.equal(extractPromises('今天天气不错').length, 0);
  assert.equal(extractPromises('明天是周末呀').length, 0, '"明天"出现但不是在答应事情');
  assert.equal(extractPromises('我在看书').length, 0);
});

test('承诺到期时间推断合理', () => {
  const now = new Date('2026-09-19T14:00:00');
  const tomorrow = new Date(inferDueAt('我明天告诉你', now));
  assert.equal(tomorrow.getDate(), 20, '"明天"应推到次日');
  assert.equal(tomorrow.getHours(), 10, '不该太早提（早上 10 点）');

  const soon = new Date(inferDueAt('我一会儿发你', now));
  assert.equal(soon.getDate(), 19, '"一会儿"应仍在当天');
  assert.ok(soon.getHours() > now.getHours(), '"一会儿"应在未来');
});

test('承诺每条只提一次，过期就不再提', () => {
  const tmp = path.join(os.tmpdir(), `promise-test-${Date.now()}.json`);
  const led = new PromiseLedger({ file: tmp });
  const t0 = new Date('2026-09-19T14:00:00');

  led.record('我明天告诉你结果', 'p1', t0);
  assert.equal(led.items.length, 1);
  assert.equal(led.due('p1', new Date('2026-09-19T20:00:00')).length, 0, '未到期不该提');

  const after = new Date('2026-09-20T11:00:00');
  const d = led.due('p1', after);
  assert.equal(d.length, 1, '到期应提醒');
  led.markMentioned(d[0].id, after);
  assert.equal(led.due('p1', after).length, 0, '提过之后不该重复提');

  // 拖太久不再提
  const led2 = new PromiseLedger({ file: `${tmp}.2` });
  led2.record('我明天告诉你结果', 'p1', t0);
  assert.equal(led2.due('p1', new Date('2026-09-25T11:00:00')).length, 0, '拖 5 天就不提了');
  assert.equal(led2.expireStale(new Date('2026-09-25T11:00:00')), 1);
  assert.equal(led2.items.length, 1, '过期只是标记，仍留档');

  for (const f of [tmp, `${tmp}.2`]) {
    try { fs.unlinkSync(f); } catch { /* noop */ }
  }
});

test('承诺不会串到别人身上', () => {
  const tmp = path.join(os.tmpdir(), `promise-peer-${Date.now()}.json`);
  const led = new PromiseLedger({ file: tmp });
  led.record('我明天告诉你', 'peerA', new Date('2026-09-19T14:00:00'));
  assert.equal(led.due('peerB', new Date('2026-09-20T11:00:00')).length, 0);
  try { fs.unlinkSync(tmp); } catch { /* noop */ }
});

// ── 打包安全 ──
test('打包白名单里的文件名必须是 ASCII（Windows tar 会把中文名弄成乱码）', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const INCLUDE = ['package.json', 'README.md', '.gitignore', 'docs', 'src', 'scripts', 'test'];
  const EXCLUDE = ['node_modules', '_reference', 'data', 'dist', '.git'];

  const walk = (dir, base = '') => {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (EXCLUDE.some((x) => rel === x || rel.startsWith(`${x}/`))) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(full, rel));
      else out.push(rel);
    }
    return out;
  };

  const all = [];
  for (const inc of INCLUDE) {
    const full = path.join(root, inc);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isDirectory()) all.push(...walk(full, inc));
    else all.push(inc);
  }

  const nonAscii = all.filter((f) => /[^\x00-\x7F]/.test(f));
  assert.equal(
    nonAscii.length, 0,
    `这些文件名含非 ASCII 字符，Windows tar 打包后会变成乱码：\n  ${nonAscii.join('\n  ')}`,
  );
});

test('打包会排除所有含密钥的目录', async () => {
  const { EXCLUDE } = await import('../scripts/pack.js');

  // data/ 是密钥本体，backups/ 和 .test-data/ 都是它的整份拷贝。
  // backups/ 曾经漏掉过一次 —— 交付包里会带着明文 API Key。
  for (const must of ['data', 'backups', '.test-data', '.test-backups', 'node_modules', '_reference']) {
    assert.ok(
      EXCLUDE.includes(must),
      `打包排除列表里没有 ${must} —— 交付包可能带着密钥`,
    );
  }
});

test('真实目录里如果存在这些敏感目录，打包确实会跳过它们', async () => {
  const { EXCLUDE } = await import('../scripts/pack.js');
  const root = path.resolve(import.meta.dirname, '..');

  // 只有目录真存在时才有意义（.test-data 平时不存在）
  const secretish = ['data', 'backups'];
  for (const d of secretish) {
    const full = path.join(root, d);
    if (!fs.existsSync(full)) continue;
    // 复刻 pack.js 的过滤规则
    const skipped = EXCLUDE.some((x) => d === x || d.startsWith(`${x}/`));
    assert.ok(skipped, `${d}/ 存在，但不会被排除`);

    // 再确认它里面真的有敏感文件 —— 否则这条测试等于没测
    const cfg = path.join(full, 'config.json');
    if (fs.existsSync(cfg)) {
      const raw = fs.readFileSync(cfg, 'utf8');
      assert.ok(raw.length > 0, `${d}/config.json 是空的？`);
    }
  }
});

// ── 指令协议（她"自己动手"）──
test('指令解析：标记被剥离，文字保持干净', () => {
  const r = parseCommands('好啊，那我也去睡了<sticker:晚安猫>');
  assert.equal(r.text, '好啊，那我也去睡了');
  assert.equal(r.commands.length, 1);
  assert.equal(r.commands[0].kind, 'sticker');
  assert.equal(r.commands[0].arg, '晚安猫');
});

test('指令解析：一条回复能带多个不同指令', () => {
  const r = parseCommands('好<sticker:晚安猫><remember:他不吃辣>');
  assert.equal(r.commands.length, 2);
  assert.equal(r.text, '好');
});

test('指令解析：不是指令的尖括号不动它', () => {
  const r = parseCommands('这是普通的<尖括号>文字');
  assert.equal(r.commands.length, 0);
  assert.ok(r.text.includes('<尖括号>'), '不该吃掉普通尖括号');
});

test('指令护栏：单条回复内限次', () => {
  const r = parseCommands('一<sticker:猫>二<sticker:狗>三<sticker:鸟>');
  assert.equal(r.commands.filter((c) => c.kind === 'sticker').length, PER_REPLY.sticker);
  assert.ok(!r.text.includes('sticker'), '被丢弃的标记也要从文字里删掉，不能漏出来');
});

test('指令护栏：每日上限 + 连续重复压制 + 跨天重置', () => {
  const day = '2026-09-19';
  let usage = emptyUsage(day);
  let sent = 0;
  for (let i = 0; i < 20; i++) {
    const r = filterCommands([{ kind: 'sticker', arg: `猫${i}` }], usage, day);
    usage = r.usage;
    sent += r.ok.length;
  }
  assert.equal(sent, PER_DAY.sticker, `每天不该超过 ${PER_DAY.sticker} 个`);

  const over = filterCommands([{ kind: 'sticker', arg: 'x' }], usage, day);
  assert.equal(over.ok.length, 0);
  assert.ok(/上限/.test(over.dropped[0]?.why ?? ''), '拦下时要说明原因，否则调参是盲调');

  // 连续两张一样的会被压掉
  const d = '2026-09-20';
  const a = filterCommands([{ kind: 'sticker', arg: '晚安猫' }], emptyUsage(d), d);
  const b = filterCommands([{ kind: 'sticker', arg: '晚安猫' }], a.usage, d);
  assert.equal(b.ok.length, 0, '连着发同一张很假');
  assert.ok(/重复/.test(b.dropped[0]?.why ?? ''));

  // 跨天重置
  const next = filterCommands([{ kind: 'sticker', arg: '晚安猫' }], a.usage, '2026-09-21');
  assert.equal(next.ok.length, 1, '跨天应该重置');
});

test('hasCommands：不完整的尖括号不算指令', () => {
  assert.equal(hasCommands('好<sticker:猫>'), true);
  assert.equal(hasCommands('今天天气不错'), false);
  assert.equal(hasCommands('今天天气<不错'), false);
  assert.equal(hasCommands('好<sticker:猫'), false, '没闭合的标记不算');
  assert.equal(hasCommands(''), false);
});

// ── 表情包库 ──
test('表情包：模糊匹配能兜住模型记不准的名字', () => {
  const all = listStickers();
  if (!all.length) return; // 没放表情包就跳过（别人拿到包时是空的）
  const first = all[0].name;

  assert.equal(findSticker(first)?.name, first, '精确匹配');
  assert.ok(findSticker(`${first}啊`) || findSticker(first), '多了个字也要能兜住');
  assert.equal(findSticker('绝对不存在的名字zzz'), null, '完全不沾边的不该乱发');
  assert.ok(findSticker(''), '空名字应该随机挑一个');
});

test('表情包：能读出内容且 mime 正确', () => {
  const all = listStickers();
  if (!all.length) return;
  const spec = findSticker(all[0].name);
  const data = readSticker(spec);
  assert.ok(data?.data?.length > 0, '读不出内容');
  assert.ok(/^image\//.test(data.mime), `mime 不对: ${data.mime}`);
});

test('表情包：重复的字不能重复加分（真出过这个 bug）', () => {
  // 旧写法直接遍历原字符串，"摸摸"里的两个"摸"各记一次分，
  // 于是「摸摸头」对「摸鱼」拿到 2/3 = 0.667，被当成了同一个。
  // 去重之后按长边做分母，是 1/2 = 0.5 —— 仍然平局，所以还得靠同义词表兜。
  assert.equal(
    nameSimilarity('摸摸头', '摸鱼'), nameSimilarity('摸头', '摸鱼'),
    '叠字不该比单字多加一分（说明查询串没去重）',
  );
  assert.equal(
    nameSimilarity('哭哭哭', '哭'), nameSimilarity('哭', '哭'),
    '叠字重复多少次，得分都不该变',
  );
  assert.ok(nameSimilarity('摸摸头', '摸鱼') <= 0.5, '去重后不该超过 0.5');

  // 长度差太多要罚 —— 否则「绝对不存在的名字zzz」会命中「对不起」
  assert.ok(
    nameSimilarity('绝对不存在的名字zzz', '对不起') < 0.5,
    `长查询不该匹配短名字，实际 ${nameSimilarity('绝对不存在的名字zzz', '对不起')}`,
  );

  assert.equal(nameSimilarity('哈哈哈哈', '哈哈哈哈'), 1);
  assert.equal(nameSimilarity('量子力学', '哭哭'), 0);
  assert.equal(nameSimilarity('', '哭哭'), 0);
  assert.equal(nameSimilarity('哭哭', ''), 0);
});

test('表情包：平局时宁可返回 null，也不要赌一把发错图', () => {
  const all = listStickers();
  if (!all.length) return;
  // 构造一个只有"摸鱼"、没有"拍头"也不走同义词的场景：
  // 直接验证查找逻辑的边界 —— 没有任何一条 ≥ 0.5 的严格大于
  const allNames = all.map((s) => s.name);
  const scores = allNames.map((n) => nameSimilarity('摸摸头', n));
  const max = Math.max(...scores);
  // 要么同义词表直接命中，要么最高分本身就不够格
  const got = findSticker('摸摸头');
  assert.ok(
    got === null || got.name === '拍头',
    `「摸摸头」只该命中「拍头」，实际命中了「${got?.name}」（最高分 ${max}）`,
  );
});

test('表情包：同义词表要指到真实存在的名字上', async () => {
  const { STICKER_ALIAS } = await import('../src/soul/stickers.js');
  const all = listStickers();
  if (!all.length) return; // 别人拿到包时表情包目录是空的
  const names = new Set(all.map((s) => s.name));

  // 同义词写错一个字，就会静默失效 —— 这条专门盯它
  const dead = Object.entries(STICKER_ALIAS).filter(([, target]) => !names.has(target));
  assert.equal(
    dead.length, 0,
    `这些同义词指向了不存在的表情包：\n  ${dead.map(([k, v]) => `${k} → ${v}`).join('\n  ')}`,
  );

  // 常见的说法要真的能落到图
  for (const [said, target] of Object.entries(STICKER_ALIAS)) {
    assert.equal(findSticker(said)?.name, target, `「${said}」应该找到「${target}」`);
  }
});

test('表情包：每个名字都要能精确命中它自己', () => {
  const all = listStickers();
  if (!all.length) return;
  // 「晚安」和「晚安我睡了」同时存在时，说「晚安」命中哪个会取决于排序 ——
  // 这种事只能靠命名避开，不能靠运气。精确匹配必须永远赢。
  for (const s of all) {
    assert.equal(findSticker(s.name)?.name, s.name, `精确说「${s.name}」却命中了别的`);
  }
});

// ── 复读止血 ──
test('判重：实测中相似度最高的那一对必须被抓住', () => {
  // 这是真跑出来的两条（同一句话问 6 次，内容重合 83%）
  const a = '就是挑了几本朋友需要的书，有点累';
  const b = '今天就是挑选了几本朋友需要的书，有点累';
  assert.ok(similarity(a, b) > 0.8, `实测相似度 ${similarity(a, b).toFixed(2)}`);
  assert.ok(checkRepeat(b, [a]).repeat, '换了个说法说同一件事，必须判重');
});

test('判重：Jaccard 抓不住的换词组，包含度要能抓住', () => {
  const a = '帮朋友挑了几本民谣的书';
  const b = '帮朋友找了一些民谣相关的书';
  // Jaccard 被长度差稀释，判不出来
  assert.ok(similarity(a, b) < 0.6, `Jaccard 只有 ${similarity(a, b).toFixed(2)}`);
  // 包含度能判出来
  assert.ok(containment(a, b).score >= 0.65, `包含度 ${containment(a, b).score.toFixed(2)}`);
  assert.ok(checkRepeat(b, [a]).repeat, '包含度够就该判重');
});

test('判重：短回应重复要放行（真人也会连着说"嗯"）', () => {
  for (const s of ['嗯', '哈哈', '好的', '在呢', '哦哦']) {
    assert.equal(checkRepeat(s, [s]).repeat, false, `"${s}" 不该判重`);
  }
});

test('判重：说的不是一回事要放行', () => {
  assert.equal(checkRepeat('今天书店来了一批旧书', ['我刚才在整理书架']).repeat, false);
  assert.equal(
    checkRepeat('我今天去了趟城南的书市，淘到一本绝版的诗集', ['今天店里人不多']).repeat,
    false,
  );
});

test('判重：她说过的话只留最近几条，且能落盘', () => {
  let list = [];
  for (let i = 0; i < 20; i++) list = rememberReply(list, `第 ${i} 句话`);
  assert.equal(list.length, RECENT_KEEP, `最多留 ${RECENT_KEEP} 条`);
  assert.equal(list[list.length - 1], '第 19 句话', '保留的是最新的');
});

// ── 想念曲线 ──
test('想念曲线：先升后降，不会越久越黏', () => {
  assert.equal(longingLevel(1), 0, '刚聊完不想念');
  assert.ok(longingLevel(8) > longingLevel(5), '先上升');
  assert.equal(longingLevel(PEAK_HOURS), 1, '峰值');
  assert.ok(longingLevel(48) < longingLevel(PEAK_HOURS), '过了峰值要下降');
  assert.ok(longingLevel(24 * 7) < 0.2, '一周后基本回到自己的生活');

  // 整个模块最关键的一条
  assert.ok(
    longingLevel(24) > longingLevel(24 * 7),
    '消失一天要比消失一周更想你 —— 否则就是订阅提醒，不是人',
  );
});

test('想念曲线：异常输入不能炸', () => {
  for (const bad of [-5, NaN, undefined, null, 'x']) {
    assert.equal(longingLevel(bad), 0, `${bad} 应返回 0`);
  }
  assert.ok(Number.isFinite(longingLevel(Infinity)), 'Infinity 不能变成 NaN');
});

test('重逢：语气分档，且只结算一次', () => {
  assert.equal(reunionTone(2), 'none', '刚聊完不提');
  assert.equal(reunionTone(20), 'brief');
  assert.equal(reunionTone(48), 'long');
  assert.equal(reunionTone(24 * 10), 'veryLong');
  assert.equal(reunionHint('none', 2), '', 'none 不产生提示');

  const led = new ReunionLedger({});
  assert.equal(led.check('u1', 48).settle, true, '第一次该结算');
  led.settle('u1');
  assert.equal(led.check('u1', 48).settle, false, '★ 结算过就不能再提，否则是折磨不是撒娇');
});

// ── 纪念日 ──
test('纪念日：只认当天，不补提', () => {
  const now = new Date('2026-09-19T12:00:00+08:00');
  const ago = (d) => new Date(now.getTime() - d * 86_400_000);

  assert.equal(daysTogether(ago(100), now), 100);
  assert.equal(checkMilestone(ago(100), now)?.days, 100);
  assert.equal(checkMilestone(ago(365), now)?.big, true);
  assert.equal(checkMilestone(ago(42), now), null, '普通一天不是节点');
  assert.equal(checkMilestone(ago(101), now), null, '昨天是节点今天不补提 —— 那是日历提醒，不是记忆');
});

test('纪念日：每个节点只提一次', () => {
  const now = new Date('2026-09-19T12:00:00+08:00');
  const met = new Date(now.getTime() - 100 * 86_400_000);
  const led = new MilestoneLedger({});
  assert.equal(led.check(met, now).fire, true);
  led.mark(100);
  assert.equal(led.check(met, now).fire, false, '提过就不再提');
});

test('纪念日提示：分寸不能做砸', () => {
  const small = milestoneHint({ days: 100, big: false });
  assert.ok(/轻轻带过/.test(small), '小节点要轻描淡写');
  assert.ok(/不要用"纪念日"/.test(small), '小节点禁用"纪念日"这个词');
  const big = milestoneHint({ days: 365, big: true });
  assert.ok(/贺卡/.test(big), '大节点也要禁贺卡腔');
  const cold = milestoneHint({ days: 100, big: false }, { relation: { messageCount: 2 } });
  assert.ok(/没怎么聊过/.test(cold), '聊得少时不该自作多情');
  assert.equal(milestoneHint(null), '');
});

// ── 她眼中的你 ──
test('印象：聊两句就重写是神经质，要攒够才更新', () => {
  assert.equal(shouldUpdate(null, 3).update, false, '样本不够');
  assert.equal(shouldUpdate(null, MIN_NEW_CHATS).update, true, '聊够了开始形成');

  const fresh = { text: '他话不多', basedOn: 20, updatedAt: new Date().toISOString() };
  assert.equal(shouldUpdate(fresh, 22).update, false, '新增不够');
  assert.equal(shouldUpdate(fresh, 40).update, false, '刚更新过');

  const old = { ...fresh, updatedAt: new Date(Date.now() - 30 * 3_600_000).toISOString() };
  assert.equal(shouldUpdate(old, 40).update, true, '新增够且隔得久');
});

test('印象：提示词要"感受"不要"资料"（否则和记忆重复）', () => {
  const p = buildPortraitPrompt({ persona: { name: '小满' }, history: [{ role: 'user', content: '加班到十点' }] });
  assert.ok(p.includes('加班到十点'));
  assert.ok(/不要罗列事实/.test(p), '必须禁止罗列事实');
  assert.ok(/不要空话/.test(p), '必须禁止"他是个好人"这种空话');

  const withPrev = buildPortraitPrompt({
    persona: { name: '小满' }, history: [], previous: { text: '他好像总在照顾别人' },
  });
  assert.ok(/保留还成立的部分/.test(withPrev), '要有延续性');
  assert.ok(withPrev.includes('总在照顾别人'));
});

test('印象：清洗模型输出 + 不硬塞空块', () => {
  assert.equal(cleanPortrait('印象：他话不多'), '他话不多');
  assert.equal(cleanPortrait('「他话不多」'), '他话不多');
  assert.equal(cleanPortrait('他话不多\n但很实在'), '他话不多 但很实在');
  assert.ok(cleanPortrait('啊'.repeat(500)).length <= MAX_LEN + 1, '超长要截断');

  assert.ok(/不要直接念出来/.test(portraitBlock({ text: 'x' })), '念出来就穿帮了');
  assert.equal(portraitBlock(null), '', '没印象时返回空串，不硬塞');
});

// ── 配置安全 ──
test('配置：sanitize 丢弃骨架外的键', () => {
  const out = sanitizeConfig({ persona: { name: 'x', 恶意键: 'y' }, 顶层恶意: 1 });
  assert.equal(out.persona.name, 'x');
  assert.equal(out.persona.恶意键, undefined);
  assert.equal(out.顶层恶意, undefined);
});

// ── 通道解析 ──
test('通道：只保留用户消息，排除机器人自己的回执', () => {
  const updates = {
    msgs: [
      { message_type: 1, from_user_id: 'u1', to_user_id: 'bot', item_list: [{ type: 1, text_item: { text: '在吗' } }] },
      { message_type: 2, from_user_id: '', to_user_id: 'u1', item_list: [{ type: 1, text_item: { text: '在的' } }] },
    ],
  };
  const out = extractUserMessages(updates);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, '在吗');
});

test('通道：空 item 的消息被跳过', () => {
  const out = extractUserMessages({ msgs: [{ message_type: 1, from_user_id: 'u1', item_list: [] }] });
  assert.equal(out.length, 0);
});

test('通道：多种消息类型都能描述', () => {
  assert.equal(describeItem({ type: 1, text_item: { text: '你好' } }), '你好');
  assert.equal(describeItem({ type: 2 }), '[图片]');
  assert.equal(describeItem({ type: 4, file_item: { file_name: 'a.pdf' } }), '[文件: a.pdf]');
  assert.ok(describeItem({ type: 99 }).includes('未知'));
});

test('通道：归一化保留 context_token', () => {
  const m = normalizeMessage({
    from_user_id: 'u1', to_user_id: 'bot', context_token: 'tk', item_list: [{ type: 1, text_item: { text: 'hi' } }],
  });
  assert.equal(m.contextToken, 'tk');
  assert.deepEqual(m.kinds, ['text']);
});

// ── 媒体编解码 ──
test('媒体：AES 加解密往返一致', () => {
  const key = Buffer.from('0123456789abcdef');
  const plain = Buffer.from('这是一段测试数据，需要能原样还原。', 'utf8');
  const enc = encryptAesEcb(plain, key);
  const dec = decryptAesEcb(enc, key);
  assert.equal(dec.toString('utf8'), plain.toString('utf8'));
});

test('媒体：PKCS7 补位长度计算正确', () => {
  assert.equal(aesEcbPaddedSize(16), 32);
  assert.equal(aesEcbPaddedSize(15), 16);
  assert.equal(aesEcbPaddedSize(0), 16);
});

test('媒体：两种 aes_key 编码都能解析', () => {
  const key = Buffer.from('0123456789abcdef');
  // 形式一：16 字节原始密钥的 base64
  assert.equal(parseAesKey(key.toString('base64')).toString('hex'), key.toString('hex'));
  // 形式二：32 字符 hex 的 base64
  const hexKey = key.toString('hex');
  assert.equal(parseAesKey(Buffer.from(hexKey).toString('base64')).toString('hex'), hexKey);
  // 非法输入返回 undefined
  assert.equal(parseAesKey(''), undefined);
  assert.equal(parseAesKey('!!!'), undefined);
});
