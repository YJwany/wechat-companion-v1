// 睡着时被找过 → 第二天早上补一句"昨晚我睡过去了"。
//
// 为什么需要单独一个模块：
//   之前提示词里**写了**这句话（persona.js 里"你只会在第二天早上简短提一句"），
//   但那段提示词永远拼不进 prompt —— 因为 shouldReply 在她睡着时提前 return 了，
//   根本没走到构建提示词那一步。**提示词和代码没接上。**
//
//   所以这里做的是：睡着时把"有人来找过"记下来，醒来后的第一轮把这件事
//   告诉她。不记账的话，她要么永远不提（现状），要么每句都提。

/**
 * 睡着期间被打扰的记录，每个 peer 一条。
 *
 * 只在醒来后的**第一轮**用掉，之后清掉 —— 不然她会连着好几轮
 * 说"我昨晚睡过去了"，那比不提还假。
 */
export class SleepLedger {
  constructor(state = {}) {
    this.state = state;
  }

  /** 她睡着时有人来找她 —— 记一笔。同一个人只留最新一次。 */
  note(peer, now = new Date()) {
    if (!peer) return;
    this.state[peer] = {
      at: new Date(now).toISOString(),
      // 被打扰了几次。她只会提一句，但次数能让这句话更有分寸
      // （被找过 5 次和 1 次，语气不该一样）
      times: (this.state[peer]?.times ?? 0) + 1,
      told: false,
    };
    this.prune();
  }

  /**
   * 现在该不该提"昨晚睡过去了"。
   *
   * 条件：①有记录 ②还没提过 ③记录是"昨晚"的（不超过 16 小时）
   * 第③条很重要 —— 三天前被打扰过，今天不该突然翻出来说。
   */
  pending(peer, now = new Date()) {
    const rec = this.state[peer];
    if (!rec || rec.told) return null;

    const at = new Date(rec.at).getTime();
    if (!Number.isFinite(at)) return null;

    const hours = (new Date(now).getTime() - at) / 3_600_000;
    if (hours < 0 || hours > 16) return null;

    return { hours, times: rec.times ?? 1 };
  }

  /** 提过了，别再提。 */
  clear(peer) {
    if (this.state[peer]) this.state[peer].told = true;
  }

  /** 只留最近 30 个人。 */
  prune() {
    const keys = Object.keys(this.state);
    if (keys.length <= 30) return;
    const sorted = keys
      .map((k) => [k, new Date(this.state[k]?.at ?? 0).getTime() || 0])
      .sort((a, b) => b[1] - a[1]);
    for (const [k] of sorted.slice(30)) delete this.state[k];
  }

  stats() {
    const keys = Object.keys(this.state);
    return { count: keys.length, pending: keys.filter((k) => !this.state[k]?.told).length };
  }
}

/**
 * 醒来后给她的提示。
 *
 * 分寸：**一句就够，不要道歉**。真人睡过去了不会写检讨，
 * 顶多说一句"啊我睡过去了"就接上正题。
 */
export function sleepHint(info) {
  if (!info) return '';
  const times = info.times ?? 1;
  const lines = [
    '【昨晚的事】',
    '昨晚你睡着的时候他找过你' + (times > 1 ? `（找了 ${times} 次）` : '') + '，你没回。',
    '现在**顺口提一句**就行，像"昨晚我睡过去了"这种 —— 一句，别多。',
    '**不要道歉，不要解释，不要问"你昨晚找我干嘛"**（他要说自然会说）。',
    '提完就正常聊。',
  ];
  return lines.join('\n');
}
