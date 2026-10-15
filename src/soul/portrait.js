// 她眼中的你：一份关于"你是什么样的人"的持续印象。
//
// 和记忆（memory）的区别 —— 这是最容易做重的地方：
//   记忆是**资料**："他住在南京""他不吃辣"。事实，可检索。
//   印象是**感受**："他说话总是先想到别人""他好像不太习惯说自己累"。
//
// 资料是查出来的，感受是处出来的。所以两者分开存，也分开注入提示词。
//
// 更新节奏：每天最多一次，而且要有足够多的新对话才更新 ——
// 聊两句就重写一遍印象，那不是了解，那是神经质。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { chat } from '../brain/client.js';

export const PORTRAIT_FILE = path.join(DATA_DIR, 'portrait.json');

/** 至少要有这么多条新消息才考虑更新。太少了样本不够。 */
export const MIN_NEW_CHATS = 8;

/** 两次更新至少隔这么久（小时）。防止一天之内反复重写。 */
export const MIN_INTERVAL_HOURS = 20;

/** 印象正文最长多少字。太长了会挤占提示词，而且不像"心里想的"。 */
export const MAX_LEN = 200;

export function readPortrait() {
  try {
    if (!fs.existsSync(PORTRAIT_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(PORTRAIT_FILE, 'utf8'));
    if (!raw || typeof raw.text !== 'string' || !raw.text.trim()) return null;
    return raw;
  } catch {
    return null;
  }
}

export function writePortrait(p) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${PORTRAIT_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2), 'utf8');
  fs.renameSync(tmp, PORTRAIT_FILE);
}

/**
 * 现在该不该更新印象。
 *
 * @param {object|null} current - 现有印象
 * @param {number} messageCount - 当前聊天总条数
 * @param {Date} now
 * @returns {{update: boolean, reason: string}}
 */
export function shouldUpdate(current, messageCount, now = new Date()) {
  if (!current) {
    return messageCount >= MIN_NEW_CHATS
      ? { update: true, reason: '还没有印象，聊够了就开始形成' }
      : { update: false, reason: `刚开始聊（${messageCount}/${MIN_NEW_CHATS}）` };
  }

  const since = messageCount - (current.basedOn ?? 0);
  if (since < MIN_NEW_CHATS) {
    return { update: false, reason: `新增对话还不够（${since}/${MIN_NEW_CHATS}）` };
  }

  const last = new Date(current.updatedAt).getTime();
  const hours = Number.isFinite(last) ? (now.getTime() - last) / 3_600_000 : Infinity;
  if (hours < MIN_INTERVAL_HOURS) {
    return { update: false, reason: `刚更新过 ${hours.toFixed(1)}h（要满 ${MIN_INTERVAL_HOURS}h）` };
  }

  return { update: true, reason: `新增 ${since} 条对话，该重新认识一下他了` };
}

/**
 * 构造让模型写印象的提示词。
 *
 * 关键约束：
 *   - 要**感受**不要**资料**（否则会和记忆重复）
 *   - 要有延续性（给旧印象，只改有新感受的部分）
 *   - 允许不确定（"好像""感觉"），因为印象本来就是模糊的
 */
export function buildPortraitPrompt({ persona, history = [], previous = null, summary = '' }) {
  const convo = history
    .slice(-24)
    .map((m) => {
      const who = m.role === 'user' ? '他' : '我';
      return `${who}: ${String(m.content ?? '').replace(/\s+/g, ' ').slice(0, 120)}`;
    })
    .join('\n');

  const lines = [
    `你在用微信和一个朋友聊天。你是「我」，对方是「他」。`,
    '',
    '最近的对话：',
    convo || '（还没有足够的对话）',
  ];

  if (summary) lines.push('', `更早之前聊过：${summary}`);

  lines.push(
    '',
    '请写一段你**对这个人的印象**，2-3 句话。要求：',
    '- 写你感觉到的他是什么样的人：性格、说话方式、在意什么、面对事情的反应',
    '- **不要罗列事实**。不要写"他住在南京""他是做设计的"这种 —— 那是资料，不是印象',
    '- 不要空话。不要写"他是个很好的人""希望他开心"这种谁都能说的话',
    '- 可以用"好像""感觉""有时候"这类不确定的词，印象本来就是模糊的',
    `- 不超过 ${MAX_LEN} 字`,
    '- 只输出印象本身，不要任何前缀、标题或引号',
    '- **直接写，不要复述上面的要求、不要解释你在做什么、不要列条目**',
  );

  if (previous?.text) {
    lines.push(
      '',
      `你之前对他的印象是：「${previous.text}」`,
      '请**更新**它，而不是推倒重来：保留还成立的部分，只改你确实有新感受的地方。',
      '如果新对话没让你改变看法，可以基本沿用原来的说法。',
    );
  }

  return lines.join('\n');
}

/**
 * 判断模型输出是不是"思考过程"而不是"印象"。
 *
 * 真踩到过：推理模型（deepseek-v4.1-flash）在写印象这种"元任务"时，
 * 会把内部推理当成正文返回（"用户要求我扮演…根据设定…我需要…"）。
 * 这段东西一旦写进 portrait.json，就会被注入系统提示词，
 * 把之后的**每一次聊天**都绕晕 —— 她开始分析提示词，而不是回话。
 * 宁可没有印象，也不要一段污染提示词的垃圾。
 */
const META_MARKERS = /(用户要求|用户说|被要求|要求我|按.{0,4}要求|根据设定|设定说|系统提示|system\s*prompt|我需要|让我先|题目要求|首先我|接下来我|这段.{0,6}是系统|对话回顾|最近的对话|只输出|不超过\s*\d+\s*字|\d\s*-\s*\d\s*句话)/i;

export function looksLikeMeta(text) {
  const t = String(text ?? '');
  if (META_MARKERS.test(t)) return true;
  // 印象是**一段自然的话**。出现列表符号或"要求/规则"这种标题，
  // 基本就是把提示词复述了一遍（真踩过："我们被要求写一段…要求：- 写感觉到的…"）。
  if (/(^|\s)[-*•]\s/.test(t)) return true;
  if (/(要求|规则|任务)\s*[:：]/.test(t)) return true;
  return false;
}

/** 清洗模型输出：去引号、去前缀、限长。 */
export function cleanPortrait(raw) {
  let t = String(raw ?? '').trim();
  // 去掉"印象："这类前缀
  t = t.replace(/^(印象|我对他的印象|他给我的感觉)[:：]\s*/i, '');
  // 去掉包裹的引号
  t = t.replace(/^["'「『]+/, '').replace(/["'」』]+$/, '');
  t = t.replace(/\s*\n+\s*/g, ' ').trim();
  if (t.length > MAX_LEN) t = `${t.slice(0, MAX_LEN)}…`;
  return t;
}

/**
 * 更新印象。会调一次模型。
 *
 * @returns {Promise<{ok: boolean, portrait?: object, reason?: string}>}
 */
export async function updatePortrait({
  cfg, persona, history, messageCount, now = new Date(), logger,
}) {
  const current = readPortrait();
  const verdict = shouldUpdate(current, messageCount, now);
  if (!verdict.update) return { ok: false, reason: verdict.reason };

  let previous = current;
  // 换了人聊天（对话历史跟上次不一样）就不硬套旧印象
  if (current?.peer && history.peer && current.peer !== history.peer) previous = null;

  const prompt = buildPortraitPrompt({
    persona,
    history: Array.isArray(history) ? history : (history.messages ?? []),
    previous,
    summary: history.summary ?? '',
  });

  // 最多试 2 次。实测这个模型约 1/3 的概率会把"思考/复述要求"当正文返回，
  // 重试一次能把成功率从 ~2/3 提到 ~8/9。印象是长期资产，值得多花一次调用。
  let text = '';
  let reason = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw;
    try {
      raw = await chat(cfg.brain, [
        { role: 'system', content: `你叫${persona?.name ?? '她'}。用第一人称写你心里的感觉，直接说，不要分析、不要复述任何要求。` },
        { role: 'user', content: prompt },
        // maxTokens 原来只有 220 —— 写"2-3 句话、200 字以内"的印象根本不够，
        // 推理模型还会先花掉一截在思考上。预算不足时的表现不是报错，
        // 而是**把提示词复述一遍当答案**（"我们被要求写一段…要求：- 写感觉到的…"），
        // 这段垃圾一旦写进 portrait.json 就会污染之后的每一次聊天。给足余量。
      ], { temperature: 0.8, maxTokens: 1600 });
    } catch (err) {
      logger?.('warn', `印象更新失败: ${err.message}`);
      return { ok: false, reason: `模型调用失败: ${err.message}` };
    }

    const t = cleanPortrait(raw);
    if (!t || t.length < 6) {
      reason = '模型没写出有效内容';
    } else if (looksLikeMeta(t)) {
      // 推理模型把"思考过程"当正文返回 —— 写进去会污染系统提示词，宁可不写
      reason = '模型返回的是思考过程';
    } else {
      text = t;
      break;
    }
    if (attempt < 2) {
      logger?.('debug', `印象生成不合格（${reason}），重试一次: ${t.slice(0, 30)}…`);
    }
  }

  if (!text) {
    logger?.('warn', `印象生成失败，已丢弃（避免污染提示词）: ${reason}`);
    return { ok: false, reason };
  }

  const portrait = {
    text,
    peer: history.peer ?? previous?.peer ?? '',
    updatedAt: new Date().toISOString(),
    basedOn: messageCount,
    version: (previous?.version ?? 0) + 1,
  };
  writePortrait(portrait);
  logger?.('info', `更新了对他的印象（第 ${portrait.version} 版）: ${text.slice(0, 40)}…`);
  return { ok: true, portrait };
}

/**
 * 把印象拼成提示词块。
 *
 * 只在有印象时返回内容 —— 没印象就别硬塞一句空的，
 * 那会让模型以为"我没印象"是件需要说出来的事。
 */
export function portraitBlock(portrait) {
  if (!portrait?.text) return '';
  return [
    '【你眼里的他】',
    '（这是你平时相处下来对他的感觉，不是别人告诉你的资料。聊天时自然带着这个印象就行，不要直接念出来。）',
    portrait.text,
  ].join('\n');
}
