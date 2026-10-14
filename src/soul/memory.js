// 记忆引擎：本地优先，不依赖任何外部向量服务。
//
// 设计取舍：Thalamus 用 mem0+faiss+bge-m3 做向量检索，效果更好但要跑一个
// Python sidecar。阶段一先做**关键词+时间衰减**的本地记忆 —— 零依赖、永远
// 能跑、跨平台。接口留成可替换的，以后要上向量库只换实现。
//
// 记忆分三桶（决定"会不会被淡忘"）：
//   fade    会淡忘 —— 日常琐事
//   solid   固化   —— 重要事实（名字、生日、忌口…）
//   self    她自己的话 —— 双向记忆：她也记得自己说过什么

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, writeJsonAtomic } from '../config.js';

const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');

/** 记忆桶的半衰期（天）。越久不提，权重越低 —— 但永不删除。 */
const BUCKET_HALFLIFE = {
  fade: 14,
  solid: 3650,   // 基本不衰减
  self: 30,
};

export class MemoryStore {
  constructor({ maxEntries = 2000 } = {}) {
    this.maxEntries = maxEntries;
    this.entries = [];
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(MEMORY_FILE)) {
        const raw = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
        this.entries = Array.isArray(raw?.entries) ? raw.entries : [];
      }
    } catch {
      // 记忆文件坏了就当空的，不要因此让她整个程序起不来
      this.entries = [];
    }
  }

  save() {
    writeJsonAtomic(MEMORY_FILE, { entries: this.entries, updatedAt: new Date().toISOString() });
  }

  /**
   * 写入一条记忆。
   * @param {string} text   - 记忆正文（第三人称陈述，如"他提到自己住在南京"）
   * @param {object} opts   - {bucket, who, source, tags}
   */
  add(text, { bucket = 'fade', who = '', source = '', tags = [] } = {}) {
    const clean = String(text ?? '').trim();
    if (!clean || clean.length < 2) return null;

    // 完全相同的内容不重复记
    const dup = this.entries.find((e) => e.text === clean && e.who === who);
    if (dup) {
      dup.recalledAt = new Date().toISOString();
      dup.hits = (dup.hits ?? 0) + 1;
      this.save();
      return dup;
    }

    const entry = {
      id: crypto.randomBytes(8).toString('hex'),
      text: clean,
      bucket,
      who,
      source,
      tags,
      createdAt: new Date().toISOString(),
      recalledAt: new Date().toISOString(),
      hits: 0,
    };
    this.entries.push(entry);

    // 超量时优先淘汰 fade 桶里最久没被想起的
    if (this.entries.length > this.maxEntries) {
      const fade = this.entries.filter((e) => e.bucket === 'fade').sort(
        (a, b) => new Date(a.recalledAt) - new Date(b.recalledAt),
      );
      const dropCount = this.entries.length - this.maxEntries;
      const dropIds = new Set(fade.slice(0, dropCount).map((e) => e.id));
      this.entries = this.entries.filter((e) => !dropIds.has(e.id));
    }

    this.save();
    return entry;
  }

  /**
   * 检索相关记忆。
   *
   * 打分 = 关键词重叠 + 意图匹配 + 时间衰减 + 桶权重。
   *
   * 为什么要做"意图匹配"：实测发现纯字面匹配命中率只有 3/8 ——
   * 用户问"我叫什么"，记忆里存的是"他叫陈默"，两者 2-gram 完全不重叠
   * （"我叫"vs"他叫"、"什么"vs"陈默"），字面方案必然召不回。
   * 所以这里先识别问题的**意图类别**（问名字/问住处/问宠物…），
   * 再把同类记忆大幅加权。这是零依赖条件下最有效的改进。
   */
  recall(query, { topK = 6, who = '' } = {}) {
    if (!this.entries.length) return [];

    const now = Date.now();
    const q = String(query ?? '');
    const grams = bigrams(q);
    const intents = detectIntents(q);

    // 有没有"实质线索"决定门槛高低。
    // 实测问题：闲聊（"哈哈哈哈""在吗"）不该召回任何记忆，但 solid 桶的
    // 基础分（时间衰减≈1 + 桶权重 0.8）本身就能过绝对阈值，导致她每收到
    // 一句"哈哈"都要读一遍你的全部档案 —— 浪费 token 且干扰回复。
    // 所以门槛按"有没有匹配线索"浮动。
    const hasSignal = grams.size > 0 || intents.size > 0;
    const threshold = hasSignal ? 0.9 : 1.8;

    const scored = this.entries.map((e) => {
      const halflife = BUCKET_HALFLIFE[e.bucket] ?? 30;
      const days = (now - new Date(e.recalledAt ?? e.createdAt).getTime()) / 86_400_000;
      const decay = Math.pow(0.5, days / halflife);

      let score = decay;
      let matched = false; // 是否真的被这条查询"勾到"

      // 1) 字面重叠（2-gram）
      if (grams.size) {
        const eGrams = bigrams(e.text);
        let hit = 0;
        for (const g of grams) if (eGrams.has(g)) hit++;
        if (hit > 0) {
          score += (hit / grams.size) * 3;
          matched = true;
        }
      }

      // 2) 意图匹配 —— 这是把命中率从 3/8 拉起来的关键
      if (intents.size) {
        const eIntents = detectIntents(e.text);
        for (const it of intents) {
          if (eIntents.has(it)) { score += 4; matched = true; }
        }
      }

      // 3) 同一个人相关的事优先
      if (who && e.who === who) score += 0.5;
      // 4) 固化桶加权
      if (e.bucket === 'solid') score += 0.8;
      // 5) 简洁优先：同等匹配下，短记忆更可能是"直接答案"
      //    （"他叫陈默" 应该排在 "他养了一只叫豆豆的柯基" 前面）
      if (matched && e.text.length <= 12) score += 1.2;

      return { entry: e, score, matched };
    });

    const picked = scored
      // 必须真的被勾到（或有强信号），否则不返回 —— 宁可少给也不要塞噪音
      .filter((s) => s.matched && s.score > threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    // 被真正想起才刷新时间（遗忘曲线的关键：不用就淡）
    for (const { entry } of picked) {
      entry.recalledAt = new Date().toISOString();
      entry.hits = (entry.hits ?? 0) + 1;
    }
    if (picked.length) this.save();

    return picked.map((s) => s.entry);
  }

  /** 最近 N 条（给后台看）。 */
  recent(limit = 50) {
    return [...this.entries]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, limit);
  }

  stats() {
    const byBucket = { fade: 0, solid: 0, self: 0 };
    for (const e of this.entries) byBucket[e.bucket] = (byBucket[e.bucket] ?? 0) + 1;
    return { total: this.entries.length, byBucket };
  }

  remove(id) {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length !== before) {
      this.save();
      return true;
    }
    return false;
  }
}

/** 中文 2-gram 集合。 */
function bigrams(text) {
  const s = String(text ?? '').replace(/[\s\p{P}]+/gu, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  return out;
}

// ── 意图识别：把"问题的语义类别"和"记忆的语义类别"对上 ──
//
// 这是零依赖条件下提升召回率最有效的手段。
// 中文里问"我叫什么"和存"他叫陈默"字面毫不相干，但语义都是「姓名」。
// 给各自打上同一类别标签，就能跨越字面差异。
const INTENT_PATTERNS = [
  // 姓名：存储侧要求"叫"后面跟的是名字而不是别的（"叫豆豆的柯基"不该算姓名）
  ['name',    /(名字|叫什么|叫啥|我是谁|怎么称呼)/,        /(^|他)叫[\u4e00-\u9fa5]{2,3}$/],
  ['city',    /(住|哪儿|哪里|哪个城市|在哪|家乡|老家)/,     /(住在|老家|城市|来自)/],
  ['pet',     /(宠物|狗|猫|养的|柯基|橘猫)/,               /(养了|宠物|柯基|橘猫)/],
  ['food',    /(吃|口味|忌口|辣|过敏|喝|酒)/,              /(吃|辣|过敏|忌口|口味|不喝)/],
  ['job',     /(工作|职业|做什么的|干什么的|上班|专业)/,     /(做|工作|职业|设计|老师|医生|程序员)/],
  ['family',  /(家人|父母|爸|妈|哥|姐|弟|妹|结婚|孩子)/,    /(爸|妈|哥|姐|弟|妹|家人|结婚|孩子)/],
  ['hobby',   /(喜欢|爱好|兴趣|爱看|爱听|爱玩)/,           /(喜欢|爱|兴趣|爱好)/],
  ['sleep',   /(几点睡|睡|作息|熬夜|失眠)/,                /(睡|熬夜|作息|失眠)/],
  ['worry',   /(烦|愁|担心|压力|焦虑|难过|发愁)/,           /(烦|愁|担心|压力|焦虑|难过)/],
  ['project', /(项目|汇报|工作上的|忙什么)/,               /(项目|汇报|工作)/],
  ['age',     /(多大|几岁|年龄)/,                          /(岁|年龄)/],
  ['weather', /(天气|下雨|冷|热)/,                         /(天气|下雨|冷|热)/],
];

/**
 * 识别一段文本属于哪些意图类别。
 * @returns {Set<string>}
 */
export function detectIntents(text) {
  const s = String(text ?? '');
  const out = new Set();
  for (const [name, askRe, storeRe] of INTENT_PATTERNS) {
    // 问法的正则用于提问，存储的正则用于记忆正文；两个都试，
    // 因为同一句话既可能是提问也可能本身就是记忆
    if (askRe.test(s) || storeRe.test(s)) out.add(name);
  }
  return out;
}
