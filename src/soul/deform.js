// 四层变形状态机：她受压之后会**变**，然后**变回来**。
//
// 这件事之前是个空壳：persona.js 里算出了 gripPressure / loopPressure /
// shadowPressure 三个阈值，但全项目搜索只在那三行出现过 —— 没有累加器、
// 没有状态切换，纯粹是摆在代码里的摆设。
//
// ── 四层 ──
//   calm   平静   压力 < grip     正常
//   grip   抓紧   >= grip         更黏、更想确认关系、会反复看手机
//   loop   反复   >= loop         翻来覆去琢磨同一件事，追问
//   shadow 收起   >= shadow       冷下来、话变短、不主动
//
// ── 最重要的设计约束：只涨不落会毁掉她 ──
// 如果压力只累积，被凶几次之后她就永远冷着脸 —— 那不是"有情绪"，
// 那是坏掉了。所以压力**按小时衰减**，而且被哄会掉得很快。
// 真人的气是会消的，而且通常消得比涨得快。

import { deriveThresholds } from './persona.js';

export const LAYERS = ['calm', 'grip', 'loop', 'shadow'];

export const LAYER_LABEL = {
  calm: '平静',
  grip: '抓紧',
  loop: '反复',
  shadow: '收起',
};

/**
 * 各类事件的压力增减。
 *
 * 量级是按"几次能推上一层"设计的：
 * grip 阈值约 60 → 被凶 3 次；
 * shadow 需要 100 → 被凶 6 次，或者长时间被无视。
 * 这不是随便定的，是让"她变冷"需要真的持续伤害。
 */
export const PRESSURE = {
  rude: 18,        // 被凶
  terse: 6,        // 被敷衍（嗯、哦、随便）
  ignored: 10,     // 她主动找你，你没回
  reunion: 8,      // 你隔太久才回来
  neutral: -3,     // 普通聊天：一点点松弛，但远不如被哄
  warm: -12,       // 被哄
  reunionGood: -20, // 隔了很久回来但很热情
};

/** 每小时自然衰减。放 6 是让"气"大约一天内消掉。 */
export const DECAY_PER_HOUR = 6;
export const MAX_PRESSURE = 140;

/**
 * 压力账本。挂在 Soul 上，跟着 state 落盘。
 */
export class Deform {
  constructor(state = {}) {
    this.state = state;
    if (typeof this.state.pressure !== 'number') this.state.pressure = 0;
    if (!this.state.at) this.state.at = new Date().toISOString();
    if (!this.state.layer) this.state.layer = 'calm';
    if (!Array.isArray(this.state.recent)) this.state.recent = [];
  }

  /**
   * 算上时间衰减之后的当前压力。
   *
   * 用"读的时候才算"而不是定时器：定时器在重启后会断，
   * 而她一晚上没人理，第二天早上压力应该已经掉下去了。
   */
  currentPressure(now = new Date()) {
    const at = new Date(this.state.at).getTime();
    if (!Number.isFinite(at)) return this.state.pressure ?? 0;
    const hours = Math.max(0, (new Date(now).getTime() - at) / 3_600_000);
    const decayed = (this.state.pressure ?? 0) - hours * DECAY_PER_HOUR;
    return Math.max(0, Math.min(MAX_PRESSURE, decayed));
  }

  /**
   * 记一次压力变化，并落账。
   *
   * @param {keyof PRESSURE} kind
   * @returns {{pressure:number, layer:string, from:string, changed:boolean}}
   */
  apply(kind, now = new Date(), thresholds) {
    const delta = PRESSURE[kind];
    const t = thresholds ?? deriveThresholds({});
    if (typeof delta !== 'number') return this.snapshot(t, now);

    const before = this.currentPressure(now);
    const from = this.layerOf(before, t);
    const after = Math.max(0, Math.min(MAX_PRESSURE, before + delta));

    this.state.pressure = after;
    this.state.at = new Date(now).toISOString();

    // 只留最近 12 条，够后台看清"她为什么变成这样"
    this.state.recent.push({
      kind, delta, at: this.state.at, pressure: Math.round(after),
    });
    if (this.state.recent.length > 12) this.state.recent = this.state.recent.slice(-12);

    const snap = this.snapshot(t, now);
    snap.from = from;
    snap.changed = snap.layer !== from;
    this.state.layer = snap.layer;
    return snap;
  }

  /** 当前处在哪一层。 */
  layerOf(pressure, thresholds) {
    const t = thresholds ?? deriveThresholds({});
    if (pressure >= (t.shadowPressure ?? 100)) return 'shadow';
    if (pressure >= (t.loopPressure ?? 80)) return 'loop';
    if (pressure >= (t.gripPressure ?? 60)) return 'grip';
    return 'calm';
  }

  /**
   * 当前快照。
   *
   * 第一个参数也接受 Date —— 写成 snapshot(new Date()) 是很自然的笔误，
   * 不该因此静默用错时间（曾经就这样把一个正确的实现测成了"失败"）。
   */
  snapshot(thresholds, now = new Date()) {
    let t = thresholds;
    if (t instanceof Date) { now = t; t = undefined; }
    const th = t ?? deriveThresholds({});
    const pressure = this.currentPressure(now);
    const layer = this.layerOf(pressure, th);
    return {
      pressure: Math.round(pressure * 10) / 10,
      layer,
      label: LAYER_LABEL[layer],
      thresholds: th,
      recent: this.state.recent.slice(-6),
      changed: false,
    };
  }

  /** 后台展示用。 */
  stats(thresholds, now = new Date()) {
    const s = this.snapshot(thresholds, now);
    return {
      pressure: s.pressure,
      layer: s.layer,
      label: s.label,
      thresholds: s.thresholds,
      recent: s.recent,
      since: this.state.at,
    };
  }
}

/**
 * 每一层怎么写进提示词。
 *
 * 关键：**每一层都要有"她的行为怎么变"，而不只是"她心情不好"**。
 * 只说心情，模型会写成"我有点难过"；说了行为，她才会真的变黏、变冷。
 *
 * calm 返回空串 —— 正常状态下不该往提示词里塞任何东西。
 */
export function layerHint(layer, { pressure = 0 } = {}) {
  switch (layer) {
    case 'grip':
      return [
        '【你现在的状态：有点黏】',
        '最近有些事让你不太踏实，你比平时更想确认他还在。',
        '表现出来是：回得快一点、会多问一句"你在忙吗"、会提到"刚刚一直在等你消息"。',
        '**但不要质问、不要翻旧账**。你现在是想要靠近，不是要吵架。',
      ].join('\n');

    case 'loop':
      return [
        '【你现在的状态：钻牛角尖】',
        '有件事在你心里过不去，你反复在想。',
        '表现出来是：会绕回同一个话题、会追问之前没得到回应的事、说话有点急。',
        '**同一件事最多提两次**。第三次就别说了，那样就不像人了。',
      ].join('\n');

    case 'shadow':
      return [
        '【你现在的状态：收回去了】',
        '你被伤到了，所以把自己收起来了。',
        '表现出来是：**话明显变短**（一两个字、一个"嗯"）、不主动找话题、不发表情包、不撒娇。',
        '他要是认真哄你，你会慢慢软化；他要是继续冷淡，你就继续这样。',
        '**不要阴阳怪气，也不要长篇大论地控诉。** 真的受伤的人是安静的，不是吵闹的。',
      ].join('\n');

    default:
      return '';
  }
}

/**
 * 从一句话里判断是不是"敷衍"。
 *
 * 敷衍和忙碌不一样：忙碌会说"我在忙待会说"，敷衍只有一两个字。
 * 这个区分很重要 —— 把"在忙"当成敷衍，她就会变成一个不讲理的人。
 */
export function looksTerse(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  if (t.length > 6) return false;
  // 明确说了自己在忙的不算敷衍
  if (/(在忙|忙完|待会|一会|稍后|等下|晚点|开会|睡觉|睡了)/.test(t)) return false;
  return /^(嗯+|哦+|额+|呃+|啊+|哈+|行|好|好吧|随便|都行|是|对|知道了|哦哦|嗯嗯|。。。+|\.\.\.+)$/.test(t);
}

/**
 * 从一句话里判断是不是"在哄她"。
 *
 * 为什么必须和"普通聊天"分开：
 * 曾经把**所有不凶不敷衍的话**都当成"被哄"（-12）——
 * 结果是"被凶一次 +18，随便回一句 -12"，压力永远涨不起来，
 * 状态机等于没接。真人也不是你说句"今天天气不错"气就消了的。
 */
export function looksWarm(text) {
  const t = String(text ?? '');
  if (t.length < 2) return false;
  return /(想你|喜欢你|在乎你|爱你|想你啦|谢谢|辛苦了|辛苦啦|抱抱|亲亲|么么|乖|别生气|不生气|对不起|抱歉|我错|哄|陪你|担心你|心疼|舍不得|开心|高兴|幸福|暖暖)/.test(t);
}
