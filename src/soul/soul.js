// 灵魂：把人格 + 世界 + 记忆组装成一次真实的回复。
//
// 这是"她"的中枢。流程：
//   收到消息 → 判断该不该回 → 组装提示词 → 调模型 → 拆条 → 按拟人节奏发出去
//
// 所有"人味"都集中在这里：拆条、打字延迟、"正在输入"状态、手滑更正、
// 记忆写入、以及"她不是每条都回"。

import { chat } from '../brain/client.js';
import {
  buildSystemPrompt, deriveTraits, deriveThresholds, splitIntoChunks, typingRhythm, maybeTypo, currentSituation,
  suppressQuestions, humanize, polishChunks,
} from './persona.js';
import { evolveTraits } from './mbti.js';
import { listStickers } from './stickers.js';
import { listPhotos } from './album.js';
import { parseCommands } from './commands.js';
import { commonSenseBlock, checkCommonSense, buildSelfCheckPrompt } from './sense.js';
import { Deform, layerHint, looksTerse, looksWarm } from './deform.js';
import { checkRepeat, retryHint, rememberReply } from './repeat.js';
import { readPortrait, portraitBlock } from './portrait.js';

/**
 * 判断用户这句话是不是"在凶她"。
 *
 * 为什么要这个：真人的性格不是恒定的 —— 被凶当天会变冷、变刺，
 * 被好好对待会变暖。参考实现把这件事做成了一套复杂的"四层变形状态机"，
 * 我们只取最朴素、最可解释的一层：**当天情绪微调，次日回落**。
 *
 * 判据必须**指向她**才算。这一点很容易写错：
 *   "工作烦死了"、"这电影真垃圾" 是在吐槽别的东西，不是在凶她。
 *   如果误判，她会无缘无故变冷 —— 那比漏判更伤"像真人"。
 * 所以要么带第二人称"你"，要么是只有对着人才说得出口的话。
 */
const RUDE_PATTERNS = [
  // 直接带"你"的敌意 —— 基本不会误判
  /你真(笨|蠢|傻|烦|讨厌)/,
  /你(闭嘴|滚|懂个屁|很烦|好烦)/,
  /你给我(滚|闭嘴)/,
  /(别|不要)(烦我|来烦我|说了)/,
  /你(根本)?(不懂|有什么用|算什么)/,
  /(废物|没用的东西)$/,
  // 只有对着人吼才合理、且句中不出现其他对象的短语
  /^(滚|闭嘴|滚开|走开)[。！!…]*$/,
];

export function detectRudeness(text) {
  const t = String(text ?? '');
  return RUDE_PATTERNS.some((re) => re.test(t));
}

export class Soul {
  constructor({ cfg, memory, world, logger }) {
    this.cfg = cfg;
    this.memory = memory;
    this.world = world;
    this.log = logger ?? (() => {});
    // 每人的关系状态
    this.relations = new Map();
    // 今天的她（缓存，按日期失效）
    this.dailyCache = new Map();
    // 性格漂移的累计信号（跨会话保留，重启不丢）
    this.drift = { rude: 0, warm: 0, chats: 0, traits: null, updatedAt: '' };
    // 她对他的持续印象（从磁盘读，更新时刷新）。
    // 和记忆分开：记忆是资料（"他住在南京"），印象是感受（"他不太习惯说自己累"）。
    this.portrait = readPortrait();
    // 变形状态机（平静/抓紧/反复/收起）。压力会随时间衰减，所以只存数值和时间点。
    this.deform = new Deform({});
  }

  /** 印象更新之后调用，让下一次回复立刻用上新印象。 */
  reloadPortrait() {
    this.portrait = readPortrait();
    return this.portrait;
  }

  /** 载入持久化的关系与性格漂移。 */
  hydrate(state = {}) {
    if (state.relations) {
      for (const [k, v] of Object.entries(state.relations)) this.relations.set(k, v);
    }
    if (state.drift) this.drift = { ...this.drift, ...state.drift };
    if (state.deform) this.deform = new Deform(state.deform);
  }

  /** 导出可持久化的状态。 */
  serialize() {
    return {
      relations: Object.fromEntries(this.relations),
      drift: this.drift,
      deform: this.deform.state,
    };
  }

  /** 她的行为阈值（由六维派生，不可手调）。 */
  thresholdsFor() {
    return deriveThresholds(this.traitsFor());
  }

  /**
   * 当前的六维性格：MBTI 基线 + 性格漂移。
   *
   * 这就是"她会长大"的落点。漂移量被 evolveTraits 钳在 ±2/周，
   * 所以她不会变成另一个人，只会慢慢被你们的关系影响。
   */
  traitsFor() {
    const base = this.drift.traits ?? deriveTraits(this.cfg.persona.mbti);
    this.drift.traits = base;
    // 当天事件带来的临时偏移（被凶当天锐度 +、温度 -），次日自然回落
    const today = this.todayDrift();
    const clamp = (v) => Math.max(5, Math.min(95, v));
    return {
      ...base,
      warmth: clamp(base.warmth + (today.warmth ?? 0)),
      sharp: clamp(base.sharp + (today.sharp ?? 0)),
    };
  }

  /**
   * 当天事件驱动的临时性格偏移。
   *
   * 为什么要有"次日回落"：真人的情绪是当天的，睡一觉就淡了。
   * 累计漂移（drift）才是长期的。两者分开，她才不会"越吵越坏"回不来。
   */
  todayDrift() {
    const key = dateKey(new Date());
    this.dailyMoodDrift = this.dailyMoodDrift ?? {};
    return this.dailyMoodDrift[key] ?? {};
  }

  /** 记录一次互动带来的情绪影响（当天生效，次日回落）。 */
  noteEvent(kind) {
    const key = dateKey(new Date());
    this.dailyMoodDrift = this.dailyMoodDrift ?? {};
    const d = this.dailyMoodDrift[key] ?? { warmth: 0, sharp: 0 };
    if (kind === 'rude') {
      d.warmth = Math.max(-15, (d.warmth ?? 0) - 5);
      d.sharp = Math.min(15, (d.sharp ?? 0) + 5);
    } else if (kind === 'warm') {
      d.warmth = Math.min(10, (d.warmth ?? 0) + 2);
      d.sharp = Math.max(-8, (d.sharp ?? 0) - 1);
    }
    this.dailyMoodDrift[key] = d;
    return d;
  }

  /**
   * 累计长期漂移（每周结算一次）。
   *
   * 参考实现的节奏是"一周一结算"。这里照做：漂移太大她就不是她了，
   * 太小又看不出变化。
   */
  settleDrift(now = new Date()) {
    const weekKey = `${now.getFullYear()}-W${Math.floor(now.getDate() / 7)}`;
    if (this.drift.updatedAt === weekKey) return null;

    const base = this.drift.traits ?? deriveTraits(this.cfg.persona.mbti);
    const next = evolveTraits(base, {
      warm: this.drift.warm,
      rude: this.drift.rude,
      chats: this.drift.chats,
    });
    const changed = JSON.stringify(next) !== JSON.stringify(base);
    this.drift.traits = next;
    this.drift.updatedAt = weekKey;
    this.drift.rude = 0;
    this.drift.warm = 0;
    this.drift.chats = 0;
    return changed ? next : null;
  }

  /**
   * 她自己决定换个称呼。
   *
   * 为什么要她自己决定：系统替她起一个外号会很假。让她按当下的关系状态
   * 自己挑一个，并写下第一人称的理由 —— 这样"改称呼"是一个有动机的行为，
   * 而不是随机文本替换。
   *
   * 触发条件是"聊得够多了"，且**每种称呼只换一次**，避免她反复横跳。
   */
  async maybeRename(peerId, history = []) {
    const rel = this.relationFor(peerId);
    // 至少聊 40 条才有资格改称呼（刚认识就叫"宝"太假）
    if (rel.messageCount < 40) return null;
    // 已经有称呼就不再改（真人也不会天天换叫法）
    if (rel.addressTerm) return null;
    // 每人最多主动改一次
    if (rel.renamedOnce) return null;

    const recent = history.slice(-16).map((m) => `${m.role === 'user' ? '他' : '我'}: ${m.content}`).join('\n');
    const prompt = `你们已经聊了一阵子了。现在请你想一个称呼他的方式。

要求：
- 就像一个真的慢慢熟起来的人会做的那样，自然一点
- 可以是"喂""你""名字"或者一个你自己给他起的小名
- 不要肉麻，不要突然很亲密（你们只是聊得来）
- 只回称呼本身，两个字以内，不要标点，不要解释

最近的对话：
${recent}

你打算怎么叫他？`;

    try {
      const term = (await chat(this.cfg.brain, [{ role: 'user', content: prompt }], {
        temperature: 0.9, maxTokens: 12,
      })).trim().replace(/["'"'。，,！!？?]/g, '').slice(0, 4);

      if (!term || term.length > 4) return null;
      rel.addressTerm = term;
      rel.renamedOnce = true;
      this.log('info', `她决定以后叫他"${term}"`);
      return term;
    } catch (err) {
      this.log('debug', `改称呼失败（保持原样）: ${err.message}`);
      return null;
    }
  }

  /** 取"今天的她"：世界引擎剧本优先，没有就用确定性随机兜底。 */
  todayFor(date = new Date()) {
    const key = dateKey(date);
    if (this.dailyCache.has(key)) return this.dailyCache.get(key);

    const script = this.world.scriptFor(key);
    const p = this.cfg.persona;

    let daily;
    if (script) {
      daily = {
        fromWorld: true,
        wakeAt: script.wakeAt,
        sleepAt: script.sleepAt,
        mood: script.mood,
        focus: script.focus,
        flow: script.flow,
        weather: script.weather,
        job: p.job,
      };
    } else {
      // 确定性随机：同一天结果固定，但明天会变
      const rnd = seededRandom(key + p.name);
      const wakeH = 6 + Math.floor(rnd() * 4);
      const sleepH = 22 + Math.floor(rnd() * 3);
      daily = {
        fromWorld: false,
        wakeAt: `${String(wakeH).padStart(2, '0')}:${rnd() > 0.5 ? '30' : '00'}`,
        sleepAt: `${String(sleepH).padStart(2, '0')}:${rnd() > 0.5 ? '30' : '00'}`,
        mood: pick(MOODS, rnd),
        focus: '',
        flow: '',
        job: p.job,
      };
    }

    this.dailyCache.set(key, daily);
    return daily;
  }

  /** 取某人的关系状态（称呼等）。 */
  relationFor(peerId) {
    if (!this.relations.has(peerId)) {
      this.relations.set(peerId, {
        peerId,
        addressTerm: '',
        messageCount: 0,
        // 她最近说过的话 —— 复读止血要靠它。放进 relation 里是为了
        // 跟着 state 一起落盘，重启后她还记得自己刚说过什么。
        recentReplies: [],
      });
    }
    const rel = this.relations.get(peerId);
    // 老 state 里没有这个字段，补上，别让判重逻辑拿到 undefined
    if (!Array.isArray(rel.recentReplies)) rel.recentReplies = [];
    return rel;
  }

  /**
   * 决定这条消息该不该回。
   * 真人不是每条都回 —— 这是"人味"里最容易被忽略、也最要紧的一条。
   */
  shouldReply(msg, ctx = {}) {
    const b = this.cfg.behavior;
    if (b.paused) return { reply: false, reason: '全局已急停' };

    // 名单过滤
    const allowed = b.allowedPeers ?? [];
    if (allowed.length && !allowed.includes(msg.fromUserId)) {
      return { reply: false, reason: '不在回复名单内' };
    }

    const daily = this.todayFor();
    const situation = currentSituation(new Date(), daily);
    if (situation.asleep) {
      return { reply: false, reason: '她睡着了' };
    }

    // 群聊/机器人的消息不回
    if (msg.messageType !== undefined && msg.messageType !== 1) {
      return { reply: false, reason: '非用户消息' };
    }

    return { reply: true };
  }

  /** 她现在是不是睡着了。给"睡着时被找过"的记账用。 */
  isAsleep(now = new Date()) {
    return !!currentSituation(now, this.todayFor()).asleep;
  }

  /**
   * 处理一条入站消息，产出要发送的内容序列。
   *
   * @returns {Promise<{chunks: string[], rhythm: {beforeFirst:number, between:number[]}, raw: string}|null>}
   */
  async respond(msg, history = []) {
    const cfg = this.cfg;
    const persona = cfg.persona;
    const daily = this.todayFor();
    const now = new Date();
    const relation = this.relationFor(msg.fromUserId);

    // 统计互动，并记录情绪影响 —— 她被凶当天会真的变冷、变刺
    relation.messageCount = (relation.messageCount ?? 0) + 1;
    this.drift.chats += 1;
    if (detectRudeness(msg.text)) {
      this.noteEvent('rude');
      this.drift.rude += 1;
      const d = this.deform.apply('rude', now, this.thresholdsFor());
      this.log('info', `他这话有点冲，她今天会冷一点${d.changed ? `（状态 → ${d.label}）` : ''}`);
    } else {
      // 每日情绪逻辑不变（非敌意就算正向互动）
      this.noteEvent('warm');
      this.drift.warm += 1;

      // 变形状态另算，分三档 —— 这三档必须分开：
      //   敷衍   → 加压
      //   哄她   → 快速消气
      //   普通聊 → 一点点松弛
      // 曾经把所有非敌意的话都当成"被哄"，于是 +18 后面跟一句
      // "今天天气不错"就 -12，压力永远涨不起来，状态机等于没接。
      if (looksTerse(msg.text)) {
        const d = this.deform.apply('terse', now, this.thresholdsFor());
        this.log('debug', `他回得很敷衍（压力 ${d.pressure}）`);
      } else if (looksWarm(msg.text)) {
        const d = this.deform.apply('warm', now, this.thresholdsFor());
        if (d.changed) this.log('info', `他被哄好了，状态回到 ${d.label}`);
      } else {
        this.deform.apply('neutral', now, this.thresholdsFor());
      }
    }

    // 六维取"基线 + 漂移 + 当天情绪"，而不是写死的 MBTI
    const traits = this.traitsFor();

    // 变形状态（平静/抓紧/反复/收起）—— 受压之后的短期状态，会随时间回落
    const layer = layerHint(this.deform.layerOf(this.deform.currentPressure(now), this.thresholdsFor()));

    // 检索相关记忆
    const memories = cfg.memory.enabled
      ? this.memory.recall(msg.text, { topK: cfg.memory.topK, who: msg.fromUserId })
      : [];

    const systemPrompt = buildSystemPrompt({
      persona,
      traits,
      daily,
      world: {
        diary: this.world.scriptFor(dateKey(new Date()))?.diary,
        thoughts: this.world.scriptFor(dateKey(new Date()))?.thoughts,
        secret: this.world.scriptFor(dateKey(new Date()))?.secret,
        npcs: this.world.scriptFor(dateKey(new Date()))?.npcs,
      },
      memories,
      relation,
      now: new Date(),
      // 她能"自己动手"的素材。只把真实存在的告诉她 ——
      // 告诉她有不存在的东西，她会去尝试然后失败。
      stickers: listStickers().map((s) => s.name),
      photos: listPhotos().map((p) => p.name),
    });

    const messages = [
      { role: 'system', content: systemPrompt },
      // 她对他的持续印象。和记忆分开：记忆是资料，印象是感受。
      ...(portraitBlock(this.portrait) ? [{ role: 'system', content: portraitBlock(this.portrait) }] : []),
      // 常识底线：这个世界怎么运转的。防止"凌晨三点说刚从银行出来"这种穿帮。
      { role: 'system', content: commonSenseBlock({ daily, now }) },
      // 她受压之后的状态。平静时是空串，不占提示词。
      ...(layer ? [{ role: 'system', content: layer }] : []),
      // 历史摘要（她"记得"更早聊过什么，但不必逐字带上）。放在最前面，
      // 让它读起来像"之前聊过这些"，而不是当前对话的一部分。
      ...(history.summary
        ? [{ role: 'system', content: `【之前聊过的】${history.summary}` }]
        : []),
      ...history.slice(-10),
      { role: 'user', content: msg.text },
    ];

    // 外部注入的提示（重逢、特殊情境）。放在最后，离本轮最近，权重最高。
    if (msg.hint) messages.push({ role: 'system', content: msg.hint });

    // 生成 + 后处理。抽成函数是为了复读的时候能**重来一次**。
    const attempt = async (hint) => {
      const msgs = hint ? [...messages, { role: 'system', content: hint }] : messages;

      let raw;
      try {
        raw = await chat(cfg.brain, msgs, {
          temperature: cfg.brain.temperature,
          maxTokens: cfg.brain.maxTokens,
        });
      } catch (err) {
        this.log('error', `模型调用失败: ${err.message}`);
        return null;
      }

      const text = String(raw ?? '').trim();
      if (!text) return null;

      // ── 先摘掉指令标记 ──
      // 必须在拆条**之前**做。否则 <sticker:晚安猫> 会被当成一句话单独成条，
      // 然后用户就会收到一条字面的 "<sticker:晚安猫>" —— 这是最容易踩的坑。
      const { text: cleaned, commands } = parseCommands(text);
      const spoken = cleaned || text; // 她只发了指令没说话时，兜个底

      // 拆条
      let chunks = splitIntoChunks(spoken, cfg.behavior.chunkMax, traits.verbosity);
      if (!chunks.length && !commands.length) return null;

      // ── 发前常识自检 ──
      // 本地先查（免费、必跑）。只有真查出问题才调模型复核 ——
      // 每条都调模型 = 每条多花 1-3 秒，而 95% 的回复根本没问题。
      const joined = chunks.join('');
      const sense = checkCommonSense(joined, { daily, now: new Date() });
      if (sense.suspect && cfg.behavior.commonSenseCheck !== false) {
        this.log('info', `常识自检发现问题，让她改口: ${sense.issues.join('；')}`);
        try {
          const fixed = await chat(cfg.brain, [
            { role: 'system', content: buildSelfCheckPrompt(joined, { daily, now: new Date(), issues: sense.issues }) },
          ], { temperature: 0.3, maxTokens: cfg.brain.maxTokens });
          const f = String(fixed ?? '').trim().replace(/^["「『]|["」』]$/g, '');
          // 只在改写结果合理时采用。模型偶尔会返回一大段解释，那就别用。
          if (f && f.length <= joined.length * 2.5 && f.length >= 2) {
            chunks = splitIntoChunks(f, cfg.behavior.chunkMax, traits.verbosity);
          }
        } catch (err) {
          this.log('debug', `常识复核失败（用原句）: ${err.message}`);
        }
      }

      // ── 后处理：洗掉"AI 味" ──
      // 顺序很重要：
      //   1. 先口语化替换（"多试试就能掌握了" → "多试几次就好了"）
      //   2. 再压制问句（替换后的句子可能又变成问句）
      //   3. 最后清标点 —— 必须在拆条之后，因为每条消息是独立的一句话，
      //      句尾的句号/问号要去掉（真人不打）
      chunks = chunks.map(humanize).filter(Boolean);
      chunks = suppressQuestions(chunks, 1).chunks;
      chunks = polishChunks(chunks);

      // 拟人节奏
      const rhythm = typingRhythm(chunks.join(''), cfg.behavior.replySpeed, chunks);

      // 手滑更正（可选）
      if (cfg.behavior.typoRate > 0 && Math.random() < 0.5 && chunks.length) {
        const t = maybeTypo(chunks[0], cfg.behavior.typoRate);
        if (t && Math.random() < 0.5) {
          // 真手滑时一半概率干脆不纠正
          chunks[0] = t.typo;
        }
      }

      return { chunks, rhythm, raw: text, commands };
    };

    let result = await attempt('');
    if (!result) return null;

    // ── 复读止血 ──
    // 实测过：同一句话问她 6 次，字面不重复，但有两组内容重合 83%
    // （「就是挑了几本朋友需要的书，有点累」vs「今天就是挑选了几本朋友需要的书，有点累」）。
    // 换个说法讲同一件事，听着就是复读。先让她说点别的；还是重复就
    // **这条不发** —— 发一句重复的话比不说话更假。
    const recent = relation.recentReplies ?? [];
    const spokenNow = result.chunks.join('');

    if (spokenNow && recent.length) {
      const dup = checkRepeat(spokenNow, recent);
      if (dup.repeat) {
        this.log('info', `她要重复自己了（${dup.reason}），让她换一件说`);
        const retry = await attempt(retryHint(recent));
        if (!retry) {
          // 重生成失败（模型抽风），宁可发原来那条也别彻底失声
          this.log('warn', '重生成失败，还是发原来那条');
        } else {
          const retryText = retry.chunks.join('');
          const still = retryText ? checkRepeat(retryText, recent) : { repeat: false };
          if (still.repeat) {
            this.log('info', `换了一件还是重复（${still.reason}），这条不发了`);
            return null;
          }
          result = retry;
        }
      }
    }

    // 记下她说过的话，供下次判重
    if (result.chunks.length) {
      relation.recentReplies = rememberReply(recent, result.chunks.join(''));
    }

    relation.messageCount += 1;

    // 注意：这里可能 chunks 为空但 commands 非空（她只发了个表情包没说话）。
    // 这种情况是合法的，调用方要按"只发图不说话"处理。
    return result;
  }

  /**
   * 一轮聊完后提炼记忆。
   *
   * 两条路径：优先用模型提炼（准，但要多花一次调用），失败或未开启时
   * 回退到规则提取。规则提取只能覆盖有限句式 —— 实测它会把"我不太能吃辣"
   * 这类否定句漏掉，所以模型提炼才是主力。
   *
   * @returns {Promise<void>}
   */
  async extractMemories(msg, replyText) {
    if (!this.cfg.memory.enabled) return;
    const who = msg.fromUserId;

    // 她自己的话进 self 桶（双向记忆）—— 她也记得自己说过什么
    if (replyText) {
      this.memory.add(replyText.slice(0, 200), { bucket: 'self', who, source: 'self' });
    }

    // 主力：用模型提炼关于对方的事实
    const usedModel = await this.extractWithModel(msg, who);
    if (!usedModel) {
      // 回退：规则提取
      this.extractWithRules(msg, who);
    }
  }

  /**
   * 用模型从这一轮对话里提炼值得长期记住的事实。
   * 只提炼**关于对方的稳定事实**，不提炼闲聊。返回是否成功。
   */
  async extractWithModel(msg, who) {
    const text = String(msg.text ?? '').trim();
    // 太短的消息不值得花一次模型调用
    if (text.length < 6) return false;

    const prompt = `从下面这句话里，提取出**关于说话者的、值得长期记住的稳定事实**。

说话者说：「${text}」

值得记的（举例）：
- 身份住址职业：他叫陈默 / 他住在南京 / 他是做设计的
- 家人宠物：他养了一只叫豆豆的柯基 / 他有个妹妹
- 口味忌口：他不吃辣 / 他不能喝酒 / 他爱吃甜食 / 他乳糖不耐
- 喜好习惯：他喜欢下雨天 / 他常熬夜 / 他爱看悬疑片
- 重要经历：他做过手术 / 他刚换工作 / 他老家在东北
- 在意的事：他最近在为房子的事发愁

不值得记的：打招呼、情绪一时的起伏（今天很累）、正在做的事（在吃饭）、天气。

注意：「不太能吃辣」属于**口味忌口**，要记下来；「今天胃疼」如果是偶发就不记，
但如果是他说明自己有胃病、过敏、忌口这类长期情况，就要记。

每条用第三人称陈述，以"他"开头，15 字以内。
只输出 JSON：{"facts": ["他不吃辣"]}
没有值得记的就输出：{"facts": []}`;

    try {
      const raw = await chat(this.cfg.brain, [{ role: 'user', content: prompt }], {
        temperature: 0.2,
        maxTokens: 1000,
        timeoutMs: 60_000,
      });

      const json = extractJson(raw);
      let parsed;
      try {
        parsed = JSON.parse(json);
      } catch (err) {
        this.log('debug', `记忆提炼 JSON 解析失败。原始返回: ${JSON.stringify(String(raw).slice(0, 300))}`);
        return false;
      }
      const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];

      for (const f of facts) {
        const clean = String(f ?? '').trim();
        if (!clean || clean.length > 60) continue;
        this.memory.add(clean, {
          bucket: isImportant(clean) ? 'solid' : 'fade',
          who,
          source: 'model',
        });
      }
      this.log('debug', `模型提炼记忆 ${facts.length} 条`);
      return true;
    } catch (err) {
      this.log('debug', `模型提炼记忆失败，回退规则提取: ${err.message}`);
      return false;
    }
  }

  /** 规则式记忆提取（回退路径，零成本）。 */
  extractWithRules(msg, who) {
    const text = msg.text ?? '';
    const patterns = [
      { re: /我(?:叫|是)([\u4e00-\u9fa5A-Za-z]{2,8})(?:[，,。\s]|$)/, tpl: (m) => `他叫${m[1]}`, bucket: 'solid' },
      { re: /我住在([\u4e00-\u9fa5]{2,10})/, tpl: (m) => `他住在${m[1]}`, bucket: 'solid' },
      { re: /我(?:在|是做)([\u4e00-\u9fa5]{2,12})(?:工作|上班)/, tpl: (m) => `他在${m[1]}工作`, bucket: 'solid' },
      { re: /我(?:的)?生日(?:是)?(\d{1,2})月(\d{1,2})[日号]/, tpl: (m) => `他生日是${m[1]}月${m[2]}日`, bucket: 'solid' },
      { re: /我养了(?:一只|一个)?(?:叫([\u4e00-\u9fa5A-Za-z]{2,8})的)?([\u4e00-\u9fa5]{2,6})/, tpl: (m) => `他养了${m[2]}${m[1] ? `，叫${m[1]}` : ''}`, bucket: 'solid' },
      { re: /我不(?:太)?能?吃([\u4e00-\u9fa5]{2,8})/, tpl: (m) => `他不能吃${m[1]}`, bucket: 'solid' },
      { re: /我(?:喜欢|爱)([\u4e00-\u9fa5]{2,12})/, tpl: (m) => `他喜欢${m[1]}`, bucket: 'fade' },
      { re: /我(?:讨厌|不喜欢)([\u4e00-\u9fa5]{2,12})/, tpl: (m) => `他讨厌${m[1]}`, bucket: 'solid' },
    ];

    for (const { re, tpl, bucket } of patterns) {
      const m = text.match(re);
      if (m) this.memory.add(tpl(m), { bucket, who, source: 'rule' });
    }

    if (text.length >= 20 && /(我觉得|我最近|我其实|我可能|我担心|我希望|我难过|我开心)/.test(text)) {
      this.memory.add(text.slice(0, 120), { bucket: 'fade', who, source: 'rule' });
    }
  }

  /** 让模型替她写一条"朋友圈文案"（内容私聊发给你，不真实发布）。 */
  async composeMoment(topic = '') {
    const script = this.world.scriptFor(dateKey(new Date()));
    const persona = this.cfg.persona;

    const prompt = `你是${persona.name}，${persona.age}岁，住在${persona.city}，${persona.job}。
${script ? `你今天：${script.flow}\n心情：${script.mood}\n天气：${script.weather}` : ''}
${topic ? `这次想发的主题：${topic}` : ''}

写一条朋友圈文案。要求：
- 20-60 字，像真人随手发的，不要标题、不要 hashtag、不要 emoji 堆砌
- 可以只是陈述一件小事，或者一句没头没尾的感慨
- 不要用书面的抒情句，不要"岁月静好"这类套话
- 直接输出文案本身，不要加引号、不要解释`;

    try {
      const text = await chat(this.cfg.brain, [{ role: 'user', content: prompt }], {
        temperature: 1.0, maxTokens: 200,
      });
      return String(text).trim().replace(/^["'「]|["'」]$/g, '');
    } catch (err) {
      this.log('error', `朋友圈文案生成失败: ${err.message}`);
      return null;
    }
  }
}

const MOODS = ['平静', '有点闷', '莫名开心', '懒懒的', '心里空空的', '挺有精神', '想安静待着', '有点烦躁'];

/**
 * 从模型回复里抠出 JSON。
 *
 * 推理模型（deepseek-v4.1-flash 这类）经常在 JSON 前后夹一大段"思考"，
 * 而且爱用中文全角引号 —— 这两件事都会让 JSON.parse 直接失败。
 * 所以：先归一化引号，再扫描所有"括号配平"的候选，返回第一个能解析的。
 */
function extractJson(text) {
  const s = String(text ?? '')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const hit = firstParsableJson(fenced[1]);
    if (hit) return hit;
  }
  const hit = firstParsableJson(s);
  if (hit) return hit;
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) return s.slice(start, end + 1);
  return s;
}

/** 扫描字符串里所有"括号配平"的 {…} 片段，返回第一个能被 JSON.parse 的。 */
function firstParsableJson(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const cand = s.slice(i, j + 1);
          try { JSON.parse(cand); return cand; } catch { /* 试下一个起点 */ }
          break;
        }
      }
    }
  }
  return null;
}

/** 判断一条事实是否"重要"（进固化桶，基本不衰减）。 */
function isImportant(fact) {
  return /姓名|叫|住在|生日|职业|工作|养了|宠物|家人|妈妈|爸爸|过敏|不能吃|讨厌|害怕|生病|手术|忌口|习惯/.test(fact);
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 确定性随机：同一 seed 永远同一序列。 */
function seededRandom(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return function next() {
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return (h >>> 0) / 4294967296;
  };
}

function pick(arr, rnd) {
  return arr[Math.floor(rnd() * arr.length)];
}
