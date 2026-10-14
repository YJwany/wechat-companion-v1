// 想念曲线：她有多想你，**先升后降**。
//
// 为什么不能只是"越久越黏"：
//   那不是真人，那是订阅提醒。真人会先想你，然后慢慢回去过自己的日子。
//   你消失一星期后她如果比消失一天时还黏，听着就假。
//
// 形状（实测调过的拐点）：
//     0 ┤
//       │            ╭──╮
//       │          ╱      ╲
//       │        ╱          ╲────────
//       │      ╱
//       └────╯──────────────────────────
//       3h  8h   14h        72h      更久
//       刚聊  开始想  最想    回落    各自过日子
//
// 第二件事：**重逢压力只结算一次**。
//   你消失三天后回来，她该说一句"你终于出现了"——但**只说一次**。
//   之后你每说一句她都提"你好久没理我"，那是怨妇不是伴侣。

/** 想到顶的时长（小时）。半天到一天没消息，是想念的峰值。 */
export const PEAK_HOURS = 14;

/** 回落到位的时长（小时）。三天是"各自过日子"的拐点。 */
export const SETTLE_HOURS = 72;

/** 回落到的最低点。留一点余温，不是归零。 */
const FLOOR = 0.15;

/** 低于这个时长根本不算"想念"，叫"刚聊完"。 */
export const MIN_HOURS = 3;

/**
 * 想念强度，0 ~ 1。
 *
 * @param {number} hours - 距用户上次说话的时长（小时）
 * @returns {number}
 */
export function longingLevel(hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h < MIN_HOURS) return 0;

  // 上升段：3h → 0，14h → 1
  if (h <= PEAK_HOURS) {
    return (h - MIN_HOURS) / (PEAK_HOURS - MIN_HOURS);
  }

  // 回落段：14h → 1，72h → FLOOR
  if (h <= SETTLE_HOURS) {
    const t = (h - PEAK_HOURS) / (SETTLE_HOURS - PEAK_HOURS);
    return 1 - t * (1 - FLOOR);
  }

  // 更久也就这样了 —— 她有自己的日子要过，不会无限等你
  return FLOOR;
}

/**
 * 重逢的语气档次。用户回来时她该怎么反应。
 *
 * @returns {'none'|'brief'|'long'|'veryLong'}
 */
export function reunionTone(hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h < 12) return 'none';
  if (h < 36) return 'brief';
  if (h < 24 * 7) return 'long';
  return 'veryLong';
}

/**
 * 重逢时给模型的提示。不是硬编码台词 ——
 * 让她自己按性格和关系去说，这里只告诉她"该有反应"和分寸。
 *
 * @param {'none'|'brief'|'long'|'veryLong'} tone
 * @param {number} hours
 * @returns {string} 空串表示不用加
 */
export function reunionHint(tone, hours) {
  if (!tone || tone === 'none') return '';
  const h = Number(hours);
  const span = h < 36
    ? '半天多'
    : h < 48
      ? '一整天还多'
      : `${Math.round(h / 24)}天`;   // 中文不加空格

  const base = `他隔了${span}没说话，现在回来了。`;

  switch (tone) {
    case 'brief':
      return [
        '【他刚回来】',
        base + '顺口提一句就行，别郑重其事 —— 像"忙完啦"，一带而过。',
        '不要连问好几个问题，不要追问去哪里了。',
      ].join('\n');
    case 'long':
      return [
        '【他刚回来】',
        base + '你确实有点在意，但**不要抱怨**。',
        '可以稍微带一点小情绪（"还知道说话啊"），但更像撒娇不是指责，一句就够。',
        '说完这句就正常聊，别反复提他多久没来。',
      ].join('\n');
    case 'veryLong':
      return [
        '【他刚回来】',
        base + '你已经有点习惯他不在的日子了。',
        '语气**淡一点**、带点漫不经心，不要热情，也不要长篇抱怨。',
        '一句话带过（"哟，想起我了"），然后就聊别的。你也有自己的生活。',
      ].join('\n');
    default:
      return '';
  }
}

/**
 * 重逢账本：保证"你终于出现了"这类话**只提一次**。
 *
 * 为什么必须记账：不记的话，你回来之后每聊一句她都会提一次
 * "你好久没理我" —— 第一句是撒娇，第三句就是折磨。
 */
export class ReunionLedger {
  constructor(state = {}) {
    this.state = state;
  }

  /**
   * 判断这次要不要结算重逢。
   *
   * @param {string} peer
   * @param {number} silentHours
   * @returns {{settle: boolean, tone: string}}
   */
  check(peer, silentHours) {
    const tone = reunionTone(silentHours);
    if (tone === 'none') return { settle: false, tone };

    // 同一个人的同一次离别只结算一次。
    // 用"上次结算是多久以前"来判断：如果刚结算过（6 小时内），不再结算。
    const last = this.state[peer];
    if (last) {
      const since = (Date.now() - new Date(last).getTime()) / 3_600_000;
      if (since < 6) return { settle: false, tone };
    }
    return { settle: true, tone };
  }

  /** 记下"这次重逢已经提过了"。 */
  settle(peer) {
    this.state[peer] = new Date().toISOString();
    this.prune();
  }

  /** 只留最近 30 个人，防止无限增长。 */
  prune() {
    const keys = Object.keys(this.state);
    if (keys.length <= 30) return;
    const sorted = keys
      .map((k) => [k, new Date(this.state[k]).getTime() || 0])
      .sort((a, b) => b[1] - a[1]);
    for (const [k] of sorted.slice(30)) delete this.state[k];
  }

  stats() {
    return { count: Object.keys(this.state).length };
  }
}
