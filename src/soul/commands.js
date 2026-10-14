// 指令协议：她"自己动手"的方式。
//
// 核心思路（借自参考实现，但做减法）：
//   不是在工具调用，而是让她**在正常说话时夹带标记**：
//
//     好啊，那我也去睡了<sticker:晚安猫>
//
//   发出去之前把标记解析出来 → 剥离文字 → 执行动作。
//   你只会看到"好啊，那我也去睡了" + 一张表情包。
//
// 为什么用标记而不是 function calling：
//   小模型（14B 甚至 7B）的工具调用很不稳定，而"在句尾写个尖括号标记"
//   几乎不会失败。而且它天然融进她的语气里。
//
// 支持的指令：
//   <sticker:名字>   发个表情包（不写名字 = 随便挑一个）
//   <image:文件名>   发相册里的某张照片
//   <remember:内容>  记住一件事
//   <nudge_at:时间>  让我在某个时间点找你说这件事  ← 保留，暂不实现执行

/** 指令正则。中英文冒号都认，允许名字里有空格前后空。 */
const CMD_RE = /<\s*(sticker|image|remember|nudge_at)\s*[:：]\s*([^<>]{0,200}?)\s*>/gi;

/** 单条回复里每种指令最多几个。 */
export const PER_REPLY = { sticker: 1, image: 1, remember: 2, nudge_at: 1 };

/** 每天每种指令的上限。防止她每句都甩图。 */
export const PER_DAY = { sticker: 8, image: 3, remember: 20, nudge_at: 3 };

/**
 * 从她的回复里解析指令，并返回"剥掉标记的干净文字"。
 *
 * @returns {{text: string, commands: Array<{kind, arg}>}}
 */
export function parseCommands(raw) {
  const src = String(raw ?? '');
  const commands = [];

  const text = src.replace(CMD_RE, (whole, kind, arg) => {
    const k = String(kind).toLowerCase();
    // 同一种在一条回复里超量就丢弃（护栏 1）
    const used = commands.filter((c) => c.kind === k).length;
    if (used >= (PER_REPLY[k] ?? 1)) return ''; // 直接删掉这个标记
    commands.push({ kind: k, arg: String(arg ?? '').trim() });
    return '';
  })
    // 剥掉标记后可能留下多余空格和空行
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();

  return { text, commands };
}

/** 这段文字里有没有指令标记（用于"发之前判断"，不真正解析）。 */
export function hasCommands(text) {
  // 必须同时有 "<类型:" 和收尾的 ">"，否则"今天天气<不错"这种也会被误判
  return /<\s*(sticker|image|remember|nudge_at)\s*[:：][^<>]*>/i.test(String(text ?? ''));
}

/**
 * 每日用量账本。存在 state 里，按天重置。
 *
 * 为什么需要：没有上限她会每句都发表情包。真人不会那样。
 */
export function emptyUsage(dayKey) {
  return { day: dayKey, counts: {}, lastByKind: {} };
}

/**
 * 过滤指令：超出每日上限的丢掉，并说明为什么。
 *
 * @param {Array} commands - parseCommands 的输出
 * @param {object} usage - 今天的用量
 * @param {string} dayKey
 * @returns {{ok: Array, dropped: Array<{kind, arg, why}>}}
 */
export function filterCommands(commands, usage, dayKey) {
  const u = usage?.day === dayKey ? usage : emptyUsage(dayKey);
  const ok = [];
  const dropped = [];

  for (const c of commands) {
    const limit = PER_DAY[c.kind] ?? 0;
    const used = u.counts[c.kind] ?? 0;
    if (used >= limit) {
      dropped.push({ ...c, why: `今天${c.kind}已经用过 ${used} 次（上限 ${limit}）` });
      continue;
    }
    // 连续两次发同一张同样的表情包很假，压掉
    if (c.kind === 'sticker' && u.lastByKind.sticker && u.lastByKind.sticker === c.arg) {
      dropped.push({ ...c, why: '跟上一条表情包重复了' });
      continue;
    }
    u.counts[c.kind] = used + 1;
    u.lastByKind[c.kind] = c.arg;
    ok.push(c);
  }

  return { ok, dropped, usage: u };
}

/** 把用量写回 state 需要的形状。 */
export function usageToState(usage) {
  return usage;
}
