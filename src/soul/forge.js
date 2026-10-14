// 人设贴合：给一段大致的人物模板，自动生成完整人设。
//
// 为什么做这个：给别人搭建时，最难的一步是"填人设"。
// 大多数人能给出一句"我想让她是个温柔的南方姑娘"，但填不出 MBTI、
// 兴趣清单、说话风格这些。而这些恰恰最影响她像不像人。
//
// 设计取舍：
//   - **不编造用户已经明确说过的**。用户说"她叫小雨"，就不许改名字。
//     模型很容易"顺手优化"，那是越权。
//   - 要**自我一致**：MBTI 要和说话风格对得上，职业要和作息/兴趣对得上。
//     "INFP + 雷厉风行 + 投行高管"这种矛盾人设是最伤的。
//   - 允许留白：用户没说的地方可以合理推断，但**不要编造具体经历**
//     （"她小时候养过一只叫豆豆的狗"这种，用户没提就别加）。

import { chat } from '../brain/client.js';
import { MBTI_LIST } from './mbti.js';

/** 人设里可以自动生成的字段。 */
export const FORGE_FIELDS = [
  'name', 'gender', 'age', 'city', 'job', 'background', 'mbti', 'speechStyle', 'interests', 'emojiRate',
];

/** 硬性范围，生成后要卡。 */
const LIMITS = {
  age: [16, 60],
  emojiRate: [0, 60],
  interestsMax: 8,
  textMax: { name: 12, city: 12, job: 40, background: 220, speechStyle: 160 },
};

/**
 * 构造生成人设的提示词。
 *
 * @param {string} template - 用户给的大致描述
 * @param {object} current - 现有配置（用来"保留用户已明确的"）
 */
export function buildForgePrompt(template, current = {}) {
  return [
    '你在帮人配置一个微信聊天伴侣的性格设定。',
    '',
    '用户给的描述：',
    String(template ?? '').trim() || '（用户没写什么，你自己设计一个自然、可信的年轻女性）',
    '',
    '请把它补全成一份完整人设，输出**严格的 JSON**，只有 JSON，不要任何解释或代码块标记。',
    '',
    '字段要求：',
    '- name：中文名或常用昵称，2-4 字',
    '- gender：female 或 male',
    `- age：${LIMITS.age[0]}-${LIMITS.age[1]} 的整数`,
    '- city：中国的城市名',
    '- job：一句自然的职业描述，像"在一家独立书店做店员"这种，不要写"公司职员"',
    '- background：2-3 句。她的生活状态、在意的事、一点小习惯。**不要编造具体经历事件**',
    '- mbti：必须是这些之一 ' + MBTI_LIST.join('/'),
    '- speechStyle：1-2 句描述她怎么说话。要具体到能照着演（句子长短、口头习惯、用不用感叹号）',
    `- interests：3-${LIMITS.interestsMax} 个短词`,
    `- emojiRate：${LIMITS.emojiRate[0]}-${LIMITS.emojiRate[1]} 的整数，表示她多常用 emoji`,
    '',
    '必须遵守：',
    '1. **用户已经明确说过的，一个字都不要改**（比如他说她叫小雨，name 就必须是小雨）',
    '2. 各字段要**互相自洽**：MBTI 和 speechStyle 要是一类人，job 和 interests、作息要能对上。'
      + '如果她说自己毒舌，speechStyle 就不能写成"淡淡的语气"',
    '3. 用户没说的地方可以合理补全，但**不要编造具体的人生事件**',
    '4. 写具体、写有质感，不要"性格开朗、乐于助人"这种谁都适用的空话',
    '5. **emojiRate 要按她的性格单独判断，不要照抄下面示例里的数字**'
      + '（话少冷淡的人 0-10，普通 10-25，活泼爱用表情的 30-50）',
    '',
    'JSON 结构（字段名照抄，**值要根据上面的人来写**）：',
    '{"name":"","gender":"female","age":0,"city":"","job":"","background":"","mbti":"","speechStyle":"","interests":[],"emojiRate":0}',
  ].join('\n');
}

/**
 * 从模型回复里挖出 JSON。
 *
 * 模型经常裹一层 ```json 或者前后带句话，这里都处理掉。
 * 挖不出来就返回 null，让调用方给出人话的错误。
 */
export function parseForgeReply(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  // 去掉 ``` 代码块围栏
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];

  for (const c of candidates) {
    if (!c) continue;
    // 直接解析
    try { return JSON.parse(c.trim()); } catch { /* 继续 */ }
    // 掐头去尾取第一个 { 到最后一个 }
    const s = c.indexOf('{');
    const e = c.lastIndexOf('}');
    if (s >= 0 && e > s) {
      try { return JSON.parse(c.slice(s, e + 1)); } catch { /* 继续 */ }
    }
  }
  return null;
}

/** 把性别归一化。模型有时会写"女"/"女性"。 */
function normGender(g) {
  const s = String(g ?? '').toLowerCase().trim();
  if (['male', 'm', '男', '男性', '男生'].includes(s)) return 'male';
  return 'female';
}

/**
 * 校验并修补模型给的人设。
 *
 * 原则：**能修就修，不能修就用现有的**。绝不因为一个字段不合法就整份丢掉 ——
 * 用户等了十几秒，不该因为 emojiRate 写成了 "20%" 就白等。
 *
 * @returns {{persona: object, warnings: string[]}}
 */
export function normalizePersona(raw, current = {}) {
  const warnings = [];
  const out = {};
  const src = raw && typeof raw === 'object' ? raw : {};

  // ── 文字类：限长 + 去空白 ──
  for (const field of ['name', 'city', 'job', 'background', 'speechStyle']) {
    const max = LIMITS.textMax[field];
    let v = src[field];
    v = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
    if (v.length > max) { v = v.slice(0, max); warnings.push(`${field} 太长，已截断`); }
    if (!v) {
      // 空的话保留用户原来的，别把已有的人设抹掉
      v = current[field] ?? '';
      if (src[field] !== undefined) warnings.push(`${field} 生成失败，保留原值`);
    }
    if (v) out[field] = v;
  }

  // ── 性别 ──
  out.gender = normGender(src.gender ?? current.gender);

  // ── 年龄 ──
  const age = Number.parseInt(src.age, 10);
  if (Number.isFinite(age)) {
    out.age = Math.min(LIMITS.age[1], Math.max(LIMITS.age[0], age));
    if (out.age !== age) warnings.push(`年龄 ${age} 超出范围，已收到 ${out.age}`);
  } else {
    out.age = current.age ?? 24;
    if (src.age !== undefined) warnings.push('年龄生成失败，保留原值');
  }

  // ── emoji 比例：模型可能给 "20%" 或 "0.2" ──
  let emoji = src.emojiRate;
  if (typeof emoji === 'string') emoji = parseFloat(emoji.replace('%', ''));
  if (typeof emoji === 'number' && emoji > 0 && emoji <= 1) emoji *= 100; // 0.2 → 20
  emoji = Number(emoji);
  if (Number.isFinite(emoji)) {
    out.emojiRate = Math.round(Math.min(LIMITS.emojiRate[1], Math.max(LIMITS.emojiRate[0], emoji)));
  } else {
    out.emojiRate = current.emojiRate ?? 20;
  }

  // ── MBTI：必须是合法值 ──
  const mbti = String(src.mbti ?? '').toUpperCase().trim();
  if (MBTI_LIST.includes(mbti)) {
    out.mbti = mbti;
  } else {
    if (src.mbti) warnings.push(`MBTI "${src.mbti}" 不认识，已用 ${current.mbti ?? 'INFP'}`);
    out.mbti = current.mbti ?? 'INFP';
  }

  // ── 兴趣：数组、去重、限个、去空 ──
  let interests = src.interests;
  if (typeof interests === 'string') interests = interests.split(/[、,，\s]+/);
  if (Array.isArray(interests)) {
    const cleaned = [...new Set(interests.map((x) => String(x).trim()).filter(Boolean))];
    if (cleaned.length > LIMITS.interestsMax) {
      warnings.push(`兴趣太多（${cleaned.length} 个），只留前 ${LIMITS.interestsMax} 个`);
    }
    out.interests = cleaned.slice(0, LIMITS.interestsMax);
  } else {
    out.interests = current.interests ?? [];
  }

  return { persona: out, warnings };
}

/**
 * 完整流程：给模板 → 生成人设。
 *
 * @returns {Promise<{ok:boolean, persona?:object, warnings?:string[], reason?:string}>}
 */
export async function forgePersona({ cfg, template, current = {} }) {
  const tpl = String(template ?? '').trim();
  if (tpl.length < 4) {
    return { ok: false, reason: '描述太短了，多写两句（比如"她是个在杭州的插画师，话不多，喜欢下雨天"）' };
  }
  if (tpl.length > 2000) {
    return { ok: false, reason: '描述太长了，精简到 2000 字以内' };
  }

  let raw;
  try {
    raw = await chat(cfg.brain, [
      { role: 'system', content: '你只输出 JSON，不输出任何其他文字。' },
      { role: 'user', content: buildForgePrompt(tpl, current) },
    ], { temperature: 0.9, maxTokens: 900 });
  } catch (err) {
    return { ok: false, reason: `模型调用失败：${err.message}` };
  }

  const parsed = parseForgeReply(raw);
  if (!parsed) {
    return { ok: false, reason: '模型没返回合法 JSON，重试一次或换个模型（小模型容易在这里翻车）' };
  }

  const { persona, warnings } = normalizePersona(parsed, current);
  return { ok: true, persona, warnings };
}

/** "X人" 里 X 不像城市的常见词，别把它们当城市。 */
const NON_CITY_PERSON = new Set([
  '女人', '男人', '个人', '别人', '大人', '老人', '好人', '坏人', '年轻人', '这种人', '那种人',
  '一个人', '两个人', '本地', '外地', '南方', '北方', '城里', '乡下', '外国', '中国',
]);

/**
 * 从用户描述里抠出他**明确指定**的字段值。
 *
 * 为什么不能只拿"现有配置"去比：用户在模板里写"她想住在成都"，
 * 而现有配置是杭州 —— 这时候该盯的是**成都**，不是杭州。
 * 现有配置只是"没被模板提到时的兜底"，模板才是他的意图。
 */
export function extractExplicit(template) {
  const t = String(template ?? '');
  const out = {};

  // ── 名字：她叫小雨 / 名字叫小雨 / 名字叫「小雨」──
  const name = t.match(/(?:名字)?(?:叫做|叫)\s*[「"'"]?([^\s，,。、！？"'」]{1,8})[」"'"]?/);
  if (name) out.name = name[1];

  // ── 城市：按可靠性依次尝试，命中一个就停 ──
  const cityPatterns = [
    /住在\s*([\u4e00-\u9fa5]{2,8}?)(?:市)?(?=[，,。、！？\s]|$)/,
    /在\s*([\u4e00-\u9fa5]{2,6}?)(?:市)?(?:工作|生活|上班|读书|上学)/,
    /来自\s*([\u4e00-\u9fa5]{2,8}?)(?:市)?(?=[，,。、！？\s]|$)/,
    /坐标\s*([\u4e00-\u9fa5]{2,8}?)(?:市)?(?=[，,。、！？\s]|$)/,
  ];
  for (const re of cityPatterns) {
    const m = t.match(re);
    if (m) { out.city = m[1].replace(/市$/, ''); break; }
  }
  // "X人"。先粗匹配再掐掉开头的代词/虚词 ——
  // 不能用字符类排除，因为"都"这种虚词同时是城市名的一部分（成都）。
  if (!out.city) {
    const m = t.match(/([\u4e00-\u9fa5]{2,6})人(?=[，,。、！？\s]|$)/);
    if (m) {
      const c = m[1].replace(/^[她他男女是个的]+/, '');
      if (c.length >= 2 && !NON_CITY_PERSON.has(c)) out.city = c;
    }
  }

  // ── 年龄：26 岁 / 26周岁。汉字数字不管（"二十六"太容易出错）──
  const age = t.match(/(\d{2})\s*(?:岁|周岁)/);
  if (age) out.age = Number(age[1]);

  // ── 性别 ──
  // 先看明确的名词（男女/男孩女孩），**代词只在没有名词时才用** ——
  // "她是个男孩"里"她"和"男孩"同时出现，该以"男孩"为准。
  const maleWord = /(男生|男孩|男的|男性|小伙子|男)/.test(t);
  const femaleWord = /(女生|女孩|姑娘|女的|女性|女)/.test(t);
  if (maleWord && !femaleWord) out.gender = 'male';
  else if (femaleWord && !maleWord) out.gender = 'female';
  else if (!maleWord && !femaleWord) {
    const he = /他/.test(t);
    const she = /她/.test(t);
    if (he && !she) out.gender = 'male';
    else if (she && !he) out.gender = 'female';
  }

  return out;
}

/**
 * 核对生成结果有没有违背用户明确说的。
 *
 * 提示词里写了"用户明确说过的不要改"，但那是**软约束**。
 * 这里做硬检查 —— 因为"贴合"正是这个功能存在的意义，
 * 生成一个漂亮但改了名字的人设，比生成失败还糟。
 *
 * @returns {string[]} 人话的差异说明
 */
export function detectOverrides(template, generated = {}, current = {}) {
  const notes = [];
  const want = extractExplicit(template);

  /**
   * 比较"用户要的"和"生成的"。
   *
   * lenient 只给名字和城市用（模型可能把"小雨"补成"林小雨"，这不算改）。
   * **性别、年龄必须严格相等** —— 曾经这里对所有字符串都做 includes，
   * 结果 'female'.includes('male') === true，性别永远判成一致。
   */
  const cmp = (field, label, { lenient = false, fmt = (v) => v } = {}) => {
    if (want[field] === undefined) return;
    const got = generated[field];
    if (got === undefined || got === null || got === '') return;

    let same;
    if (lenient && typeof got === 'string' && typeof want[field] === 'string') {
      same = got === want[field] || got.includes(want[field]) || want[field].includes(got);
    } else {
      same = got === want[field];
    }
    if (!same) {
      notes.push(`你写的是「${fmt(want[field])}」，生成的是「${fmt(got)}」—— 建议手动改回${label}`);
    }
  };

  cmp('name', '名字', { lenient: true });
  cmp('city', '城市', { lenient: true });
  cmp('age', '年龄');
  cmp('gender', '性别', { fmt: (v) => (v === 'male' ? '男' : '女') });

  return notes;
}
