// MBTI → 六维人格映射。
//
// 六维含义（都是 0-100）：
//   warmth     温度   —— 对人热不热络，决定关心的话说不说
//   sharp      锐度   —— 说话冲不冲，决定损人和直接的程度
//   verbosity  话痨   —— 话多不多，决定拆成几条发
//   attachment 依恋   —— 黏不黏人，决定主动找你的频率与思念强度
//   order      秩序感 —— 生活规不规律，决定作息稳定度与抗压
//   openness   开放性 —— 爱不爱尝新，决定兴趣爱好会不会变
//
// 推导思路：MBTI 四个维度各影响两到三个六维值，做加权叠加。
// 数值不是玄学 —— 它们直接决定提示词里的行为描述和后台显示的阈值。

const DIMENSIONS = {
  E: { warmth: +12, verbosity: +14, attachment: +6 },
  I: { warmth: -10, verbosity: -12, attachment: -4 },
  S: { order: +12, openness: -14, verbosity: +2 },
  N: { order: -8, openness: +16, verbosity: +4 },
  T: { warmth: -10, sharp: +14, order: +4 },
  F: { warmth: +14, sharp: -12, attachment: +6 },
  J: { order: +16, openness: -6, attachment: -2 },
  P: { order: -14, openness: +12, sharp: +4 },
};

/** 八维基线：所有类型从 50 出发，再按字母加权。 */
function build(mbti) {
  const t = { warmth: 50, sharp: 50, verbosity: 50, attachment: 50, order: 50, openness: 50 };
  for (const ch of String(mbti).toUpperCase()) {
    const delta = DIMENSIONS[ch];
    if (!delta) continue;
    for (const [k, v] of Object.entries(delta)) t[k] += v;
  }
  // 钳制到 5-95，避免极端值让行为描述失真
  for (const k of Object.keys(t)) t[k] = Math.max(5, Math.min(95, t[k]));
  return t;
}

/** 全部 16 型预生成（查表比每次计算快，也便于后台展示）。 */
export const MBTI_TRAITS = Object.fromEntries(
  ['E', 'I'].flatMap((a) => ['S', 'N'].flatMap((b) => ['T', 'F'].flatMap((c) => ['J', 'P'].map((d) => {
    const key = a + b + c + d;
    return [key, build(key)];
  })))),
);

export const MBTI_LIST = Object.keys(MBTI_TRAITS);

/**
 * 按性格每周微调（成长）。
 * 合计不超过 ±5，每维 -2~+2 —— 她会长大，但不会变成另一个人。
 */
export function evolveTraits(traits, signals = {}) {
  const { warm = 0, rude = 0, chats = 0 } = signals;
  const out = { ...traits };
  const clamp = (v) => Math.max(5, Math.min(95, v));

  // 被凶多了锐度上升、温度下降；聊得多温度上升
  const warmthDelta = Math.max(-2, Math.min(2, Math.round(chats / 40 - rude / 3)));
  const sharpDelta = Math.max(-2, Math.min(2, Math.round(rude / 4)));
  const attachmentDelta = Math.max(-2, Math.min(2, Math.round(warm / 30)));

  out.warmth = clamp(out.warmth + warmthDelta);
  out.sharp = clamp(out.sharp + sharpDelta);
  out.attachment = clamp(out.attachment + attachmentDelta);
  return out;
}
