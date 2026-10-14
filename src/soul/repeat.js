// 复读止血：她不能把同一件事换着说法反复讲。
//
// 为什么需要（有实测数据支撑）：
//   同一句话问 6 次，字面重复 0 组 —— 但有两组相似度 0.83：
//     「就是挑了几本朋友需要的书，有点累」
//     「今天就是挑选了几本朋友需要的书，有点累」
//   换了措辞，说的是同一件事。真人不会这样，真人会说"刚不是说了嘛"。
//
// 策略（照搬参考实现的原则：重复就换一件事，换不出来这条就不发）：
//   1. 生成后先跟自己最近几条比
//   2. 判为重复 → 带着"别重复"的提示重生成一次
//   3. 还是重复 → **这条不发**。发一条重复的话比不说话更假。

/**
 * 虚词表。判重前先剔掉 —— 它们出现在几乎每句话里，
 * 留着会把"完全不同的两件事"算得很像。
 */
const STOP = new Set(
  '的了着过吗呢吧啊呀嘛哦嗯是在有和与就也都还很太不我你他她它们这那个些一又再会能要想把被给对从到'.split(''),
);

/** 去掉标点空白，只留下内容字符。 */
export function normalizeForCompare(text) {
  return String(text ?? '')
    .replace(/\s+/g, '')
    .replace(/[。，、！？!?,.;:：；""''「」『』【】（）()~～\-—_·]/g, '')
    .toLowerCase();
}

/** 只留内容字（剔掉虚词）。 */
export function contentChars(text) {
  const out = new Set();
  for (const ch of normalizeForCompare(text)) {
    if (!STOP.has(ch)) out.add(ch);
  }
  return out;
}

/**
 * 字符集 Jaccard 相似度（保留作为参考指标，判重主要用包含度）。
 */
export function similarity(a, b) {
  const A = new Set(normalizeForCompare(a));
  const B = new Set(normalizeForCompare(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const ch of A) if (B.has(ch)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * 内容包含度 = 交集 ÷ 较短那条。
 *
 * 为什么不用 Jaccard：Jaccard 会被长度差异稀释。
 *   「帮朋友挑了几本民谣的书」vs「帮朋友找了一些民谣相关的书」
 *   Jaccard 只有 0.50（判不出来），包含度 0.67（判得出来）——
 *   因为它们说的是同一件事，只是长短和用词不同。
 */
export function containment(a, b) {
  const A = contentChars(a);
  const B = contentChars(b);
  if (!A.size || !B.size) return { score: 0, shared: 0 };
  let shared = 0;
  for (const ch of A) if (B.has(ch)) shared++;
  return { score: shared / Math.min(A.size, B.size), shared };
}

/** 太短的回应（"嗯""哈哈""好的""在呢"）天然会重复，不该拦。 */
const SHORT_REPLY = 4;

/** 判重阈值。低于这个值就放行。 */
const THRESHOLD = 0.65;

/** 至少要有这么多共同内容字才算重复 —— 防止两句话偶然撞几个字就被误判。 */
const MIN_SHARED = 4;

/**
 * 判断这条回复是不是复读。
 *
 * @param {string} text - 本次要发的话
 * @param {string[]} recent - 她最近说过的话（越新越靠后）
 * @returns {{repeat: boolean, reason?: string, score?: number, against?: string}}
 */
export function checkRepeat(text, recent = []) {
  const norm = normalizeForCompare(text);

  // 短回应不判重 —— 真人也总说"嗯""哈哈""好的"
  if (norm.length <= SHORT_REPLY) return { repeat: false };

  for (const prev of recent) {
    const pnorm = normalizeForCompare(prev);
    if (!pnorm) continue;

    // 字面判重
    if (norm === pnorm) {
      return { repeat: true, reason: '跟之前说过的完全一样', score: 1, against: prev };
    }

    const { score, shared } = containment(text, prev);
    if (score >= THRESHOLD && shared >= MIN_SHARED) {
      return {
        repeat: true,
        reason: `跟之前说的太像（内容重合 ${(score * 100).toFixed(0)}%）`,
        score,
        against: prev,
      };
    }
  }
  return { repeat: false };
}

/** 她最近说过的话最多留几条。太多了会把正常对话也判成重复。 */
export const RECENT_KEEP = 6;

/** 记一条她说过的话。 */
export function rememberReply(recent, text) {
  const list = Array.isArray(recent) ? recent.slice() : [];
  if (!normalizeForCompare(text)) return list;
  list.push(String(text));
  return list.slice(-RECENT_KEEP);
}

/**
 * 给模型的重生成提示。
 *
 * 关键是**给她一个新方向**，而不是只说"别重复" ——
 * 只说别重复，模型往往会换个说法讲同一件事，那还是重复。
 */
export function retryHint(recent = []) {
  const last = recent.slice(-3).map((r) => `"${String(r).slice(0, 40)}"`).join('、');
  return [
    '【刚才那段话不要再说】',
    last ? `你最近已经说过：${last}` : '',
    '换一件**不同的事**来说 —— 今天别的见闻、你突然想到的东西、或者对他这句话本身的反应。',
    '不要只是换个说法重复刚才的意思。如果实在没有别的可说，就简单应一声，别硬找话说。',
  ].filter(Boolean).join('\n');
}
