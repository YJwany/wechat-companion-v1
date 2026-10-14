// 纪念日：她记得"我们认识多久了"。
//
// 为什么值得做：这是"关系有连续性"最便宜的一种体现。
// 一个认识 100 天的人和一个刚认识的人，说话的分量不一样。
//
// 设计取舍：
//   - 纪念日**她主动提**，不是系统弹通知。提的时候要融在聊天里，
//     不能像日历提醒（"今天是我们的第 100 天纪念日哦！" 那种就太假了）。
//   - 每个节点**只提一次**，而且过了当天就不补提 —— 真人也不会记得补。
//   - 大节点（一年）和小节点（100 天）语气不同：小节点轻描淡写，
//     大节点才有资格郑重点。

/** 值得记的节点（天）。顺序无所谓，会排序。 */
export const MILESTONES = [7, 30, 100, 200, 365, 500, 730, 1000];

/**
 * 从认识到现在过了几天。
 * @returns {number} 天数（不足一天算 0）
 */
export function daysTogether(metAt, now = new Date()) {
  const t0 = new Date(metAt).getTime();
  if (!Number.isFinite(t0)) return 0;
  const diff = new Date(now).getTime() - t0;
  if (diff < 0) return 0;
  return Math.floor(diff / 86_400_000);
}

/**
 * 检查今天是不是节点日。
 *
 * 只看**恰好当天**，不补提 —— 她昨天没上线，今天就不该突然说
 * "前天是我们认识 100 天"。那是提醒事项，不是记忆。
 *
 * @returns {{days: number, label: string, big: boolean}|null}
 */
export function checkMilestone(metAt, now = new Date()) {
  const days = daysTogether(metAt, now);
  if (days <= 0) return null;

  const hit = MILESTONES.find((m) => m === days);
  // 满一年之后按整年算
  const yearly = days >= 365 && days % 365 === 0;

  if (!hit && !yearly) return null;

  const n = hit ?? days;
  const years = n / 365;
  const label = Number.isInteger(years) && years >= 1
    ? `认识 ${years} 年`
    : `认识 ${n} 天`;

  return { days: n, label, big: n >= 365 };
}

/**
 * 纪念日给模型的提示。
 *
 * 刻意**不给她台词** —— 让她自己按性格和当下的关系去说。
 * 硬编码一句"今天是我们认识 100 天"会毁掉人味。
 */
export function milestoneHint(m, { relation = {} } = {}) {
  if (!m) return '';
  const chats = relation.messageCount ?? 0;

  const lines = ['【今天是个特别的日子】', `你和他认识满 ${m.days} 天了。`];

  if (m.big) {
    lines.push('你可以正经一点提一句 —— 但不要煽情，不要长篇，一两句就够。');
    lines.push('别写"纪念日快乐"这种像贺卡的话。');
  } else {
    lines.push('**轻轻带过**就行。比如说一句"认识你也有一阵子了"这种感觉，然后继续聊别的。');
    lines.push('不要郑重其事，不要用"纪念日"这个词。');
  }

  if (chats < 20) {
    // 聊得很少，关系没到那份上，别自作多情
    lines.push('（你们其实没怎么聊过，所以这句话要更随意，甚至可以只是心里想想不说出来。）');
  }
  return lines.join('\n');
}

/**
 * 纪念日账本：每个节点只提一次。
 */
export class MilestoneLedger {
  constructor(state = {}) {
    this.state = state;
  }

  /**
   * 今天要不要提某个节点。
   * @returns {{fire: boolean, milestone: object|null}}
   */
  check(metAt, now = new Date()) {
    const m = checkMilestone(metAt, now);
    if (!m) return { fire: false, milestone: null };
    if (this.state[m.days]) return { fire: false, milestone: m }; // 已经提过
    return { fire: true, milestone: m };
  }

  /** 记下提过了。 */
  mark(days) {
    this.state[String(days)] = new Date().toISOString().slice(0, 10);
  }

  /** 已经提过哪些。 */
  done() {
    return Object.keys(this.state).map(Number).sort((a, b) => a - b);
  }

  /** 下一个还没到的节点（后台展示用）。 */
  next(metAt, now = new Date()) {
    const days = daysTogether(metAt, now);
    const next = MILESTONES.find((m) => m > days);
    if (!next) {
      // 超过最后一个节点就按整年推
      const years = Math.floor(days / 365) + 1;
      return { days: years * 365, inDays: years * 365 - days };
    }
    return { days: next, inDays: next - days };
  }
}
