// 承诺账本：她答应过的事，得真的记得去兑现。
//
// 为什么单独做一件事：这是"像真人"最容易被忽略、但感知最强的一条 ——
// 她说"明天告诉你"，第二天真的提起来，你会觉得她记性好、在乎你；
// 如果说完就忘，那她立刻退回成一个"每句都独立生成的机器人"。
//
// 设计取舍：
//   - 不调模型抽取承诺。承诺有很强的句式特征（"我明天…""等我…"），
//     用规则抓准确率已足够，而且**零成本、零延迟、不会失败**。
//   - 到期后只提一次，拖太久就悄悄过期 —— 真人也会忘掉小事，
//     但不会忘掉"答应了你就一定会说"这种大事（那个由主动消息兜底）。
//   - 过期不是删除，标记一下留档，后台能看见"她答应过但没做到"。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, writeJsonAtomic, readJsonSafe } from '../config.js';

const PROMISE_FILE = path.join(DATA_DIR, 'promises.json');

/** 抓"她答应了什么"。命中即记一条，宁少勿滥。 */
const PROMISE_PATTERNS = [
  // "我明天告诉你" / "我明天再跟你说"
  /我(明天|后天|待会|一会儿|等下|回头|下次)[^。！？!?]{0,20}(告诉|说|发|给|问|查|带|拍|买)/,
  // "等我查查" / "等我问一下"
  /等我[^。！？!?]{0,12}(查|问|看|找|试|忙完)/,
  // "我问一下X" / "我看看再跟你说"
  /我(问一下|看看|查一下|试试)[^。！？!?]{0,12}(再|就)?(说|告诉你|回复你|跟你)/,
  // "到时候给你看" / "改天给你看"
  /(改天|到时候|明天)[^。！？!?]{0,10}(给你看|给你带|发你|告诉你)/,
  // "我记得……" 表示她主动承担了某事
  /我记(得|一下)[^。！？!?]{0,16}(提醒|告诉|说|问|带)/,
];

/** 从她的回复里抽出承诺。返回承诺文本数组（去重）。 */
export function extractPromises(replyText) {
  const text = String(replyText ?? '').replace(/\s+/g, ' ');
  if (!text) return [];

  const found = [];
  // 按句子切，避免跨句误抓
  const sentences = text.split(/(?<=[。！？!?])/).filter(Boolean);
  for (const s of sentences) {
    for (const re of PROMISE_PATTERNS) {
      if (re.test(s)) {
        const clean = s.replace(/^[，,、\s]+/, '').trim().slice(0, 50);
        if (clean && !found.includes(clean)) found.push(clean);
        break; // 一句只记一条
      }
    }
  }
  return found;
}

/** 从承诺文本里猜"什么时候该提"。默认第二天。 */
export function inferDueAt(text, now = new Date()) {
  const t = String(text ?? '');
  const due = new Date(now);

  if (/待会|一会儿|等下|马上/.test(t)) {
    // 当天稍后：2 小时后
    due.setHours(due.getHours() + 2);
  } else if (/明天/.test(t)) {
    due.setDate(due.getDate() + 1);
    due.setHours(10, 0, 0, 0); // 早上 10 点提，别太早
  } else if (/后天/.test(t)) {
    due.setDate(due.getDate() + 2);
    due.setHours(10, 0, 0, 0);
  } else if (/下次|改天|回头/.test(t)) {
    // 模糊的承诺：给一周的窗口
    due.setDate(due.getDate() + 7);
    due.setHours(10, 0, 0, 0);
  } else {
    due.setDate(due.getDate() + 1);
    due.setHours(10, 0, 0, 0);
  }
  return due.toISOString();
}

/**
 * 承诺账本。
 *
 * 存盘格式：{ items: [{ id, text, peer, madeAt, dueAt, mentionedAt, expired }] }
 */
export class PromiseLedger {
  constructor({ file = PROMISE_FILE } = {}) {
    this.file = file;
    const raw = readJsonSafe(this.file, { items: [] });
    this.items = Array.isArray(raw?.items) ? raw.items : [];
  }

  save() {
    writeJsonAtomic(this.file, { items: this.items, updatedAt: new Date().toISOString() });
  }

  /**
   * 记下她刚说出口的承诺。
   * @returns {number} 新记下的条数
   */
  record(replyText, peer, now = new Date()) {
    const promises = extractPromises(replyText);
    let added = 0;
    for (const text of promises) {
      // 同一条不重复记（她可能连着说两次）
      if (this.items.some((it) => it.text === text && it.peer === peer && !it.expired)) continue;
      this.items.push({
        id: `${now.getTime()}-${Math.random().toString(16).slice(2, 8)}`,
        text,
        peer,
        madeAt: now.toISOString(),
        dueAt: inferDueAt(text, now),
        mentionedAt: '',
        expired: false,
      });
      added++;
    }
    if (added) this.save();
    return added;
  }

  /**
   * 取到期该提的承诺（每条只提一次）。
   *
   * 超过 3 天还没提的就不提了 —— 她自己也会忘掉小事，
   * 隔一周突然翻出来"我上周说要问你的事"反而很怪。
   */
  due(peer, now = new Date(), { maxAgeDays = 3 } = {}) {
    const nowMs = now.getTime();
    return this.items.filter((it) => {
      if (it.expired || it.mentionedAt || it.peer !== peer) return false;
      const dueMs = new Date(it.dueAt).getTime();
      if (dueMs > nowMs) return false;
      const ageDays = (nowMs - dueMs) / 86_400_000;
      return ageDays <= maxAgeDays;
    });
  }

  /** 标记已提过（不再重复提）。 */
  markMentioned(id, now = new Date()) {
    const it = this.items.find((x) => x.id === id);
    if (it) {
      it.mentionedAt = now.toISOString();
      this.save();
    }
  }

  /** 悄悄过期：拖太久的承诺不再提，但留档可查。 */
  expireStale(now = new Date(), { maxAgeDays = 3 } = {}) {
    let n = 0;
    for (const it of this.items) {
      if (it.expired || it.mentionedAt) continue;
      const ageDays = (now.getTime() - new Date(it.dueAt).getTime()) / 86_400_000;
      if (ageDays > maxAgeDays) { it.expired = true; n++; }
    }
    if (n) this.save();
    return n;
  }

  /** 后台展示用。 */
  stats() {
    return {
      total: this.items.length,
      pending: this.items.filter((i) => !i.expired && !i.mentionedAt).length,
      kept: this.items.filter((i) => i.mentionedAt).length,
      expired: this.items.filter((i) => i.expired).length,
    };
  }

  /** 最近若干条（后台展示）。 */
  recent(limit = 20) {
    return this.items.slice(-limit).reverse();
  }
}
