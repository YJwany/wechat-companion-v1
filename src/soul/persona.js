// 人格引擎：把"她是谁"翻译成一份会随时间变化的提示词。
//
// 这是决定她像不像真人的地方。核心设计（借鉴成熟实现，代码独立编写）：
//   1. 她不是在"扮演"一个活人，她是被安排了一套"活着的规则"。
//   2. 提示词里必须给她"此刻的处境"（几点、在做什么、什么心情），
//      否则模型会自由发挥，说出"周日早上我去银行"这种穿帮话。
//   3. 她的回复允许不完美：可以短、可以岔开话题、可以不想说话。

import { MBTI_TRAITS } from './mbti.js';

/** 六维人格：从 MBTI 推导，决定她"怎么反应"而不是"说什么"。 */
export function deriveTraits(mbti) {
  const base = MBTI_TRAITS[mbti] ?? MBTI_TRAITS.INFP;
  return { ...base };
}

/**
 * 从六维派生行为阈值（后台只读，不可手调 —— 想改阈值得改她的性格）。
 */
export function deriveThresholds(traits) {
  return {
    // 秩序感 → 耐操；依恋 → 易崩；锐度 → 狠度
    gripPressure: 60 + Math.round((traits.order ?? 50) * 0.3 - (traits.attachment ?? 50) * 0.2),
    loopPressure: 80 + Math.round((traits.order ?? 50) * 0.2 - (traits.attachment ?? 50) * 0.3),
    shadowPressure: 100,
  };
}

function timeOfDayGreeting(hour) {
  if (hour < 5) return '凌晨';
  if (hour < 9) return '早上';
  if (hour < 12) return '上午';
  if (hour < 14) return '中午';
  if (hour < 18) return '下午';
  if (hour < 23) return '晚上';
  return '深夜';
}

/**
 * 根据作息算出"她此刻在做什么"。
 * 这是解决穿帮的关键：给她一个唯一答案，而不是让她自己猜。
 */
export function currentSituation(now, daily) {
  const hour = now.getHours();
  const minute = now.getMinutes();
  const minutes = hour * 60 + minute;

  const sleepAt = daily?.sleepAt ?? '23:30';
  const wakeAt = daily?.wakeAt ?? '07:30';
  const toMin = (s) => {
    const [h, m] = String(s).split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const sleepMin = toMin(sleepAt);
  const wakeMin = toMin(wakeAt);

  // 睡眠窗口跨零点与否要分别判断
  const asleep = sleepMin > wakeMin
    ? (minutes >= sleepMin + 45 || minutes < wakeMin)
    : (minutes >= sleepMin + 45 && minutes < wakeMin);

  if (asleep) return { asleep: true, activity: '睡着了' };

  if (daily?.flow) {
    // ── 有世界引擎剧本时：从全天流水里挑出"此刻"这一段 ──
    // 早期版本直接把整天的流水当作"此刻在干嘛"，导致她回答"在干嘛"时
    // 会把一整天倒出来 —— 这是最明显的"不像真人"来源。
    // 真人只会说现在这一秒在做什么。
    const slot = pickTimeSlice(daily.flow, minutes, daily);
    return {
      asleep: false,
      activity: slot,
      todaySummary: daily.flow, // 全天梗概留作背景，不当作"此刻"
      fromWorld: true,
    };
  }

  // 没有剧本时的常识兜底，避免她随口说"我在上班"而此刻其实是深夜
  // 职业描述可能是"在一家书店做店员"这种自带"在"的短语，拼接前先剥掉
  const jobPhrase = String(daily?.job ?? '').replace(/^在/, '');
  const atJob = jobPhrase ? `在${jobPhrase}` : '在做点事情';

  if (minutes < 9 * 60) return { asleep: false, activity: '刚起来，还在收拾' };
  if (minutes < 12 * 60) return { asleep: false, activity: atJob };
  if (minutes < 14 * 60) return { asleep: false, activity: '在吃午饭' };
  if (minutes < 18 * 60) return { asleep: false, activity: atJob };
  if (minutes < 21 * 60) return { asleep: false, activity: '在家待着' };
  return { asleep: false, activity: '准备洗漱睡觉了' };
}

/**
 * 从全天流水里切出"此刻"正在做的那一段。
 *
 * 流水的形态不固定（世界引擎自由发挥），所以策略是三级降级：
 *   1. 优先找带时间词的片段（上午/下午/晚上/中午…）并匹配当前时段
 *   2. 退而求其次：按标点切成小句，按时段进度取对应的那一句
 *   3. 再退：取第一句，避免她把全天都说出来
 */
function pickTimeSlice(flow, minutes) {
  const text = String(flow ?? '').trim().replace(/^今天/, '');
  if (!text) return '在忙自己的事';

  // 时段划分
  const period = minutes < 9 * 60 ? '早'
    : minutes < 12 * 60 ? '上午'
      : minutes < 14 * 60 ? '中午'
        : minutes < 18 * 60 ? '下午'
          : minutes < 22 * 60 ? '晚上' : '深夜';

  // 时间词 → 时段关键词
  const words = {
    早: ['早上', '早晨', '清晨', '一早', '早起'],
    上午: ['上午', '早上', '早晨'],
    中午: ['中午', '午饭', '午餐'],
    下午: ['下午', '午后'],
    晚上: ['晚上', '傍晚', '夜里', '入夜'],
    深夜: ['晚上', '深夜', '夜里'],
  }[period] ?? [];

  // 按标点切成小句
  const clauses = text.split(/[，,。；;、]/).map((s) => s.trim()).filter(Boolean);
  if (!clauses.length) return '在忙自己的事';

  // 1) 找带当前时段时间词的句子
  for (const c of clauses) {
    if (words.some((w) => c.includes(w))) return c;
  }

  // 2) 按位置估算：流水大致按时间顺序写，取当前时段对应比例的那一句
  if (clauses.length >= 2) {
    const dayProgress = Math.min(Math.max((minutes - 8 * 60) / (14 * 60), 0), 0.999);
    const idx = Math.floor(dayProgress * clauses.length);
    return clauses[Math.min(idx, clauses.length - 1)];
  }

  // 3) 只有一句：直接用
  return clauses[0];
}

/**
 * 组装系统提示词。
 *
 * @param {object} opts
 * @param {object} opts.persona  - 她是谁
 * @param {object} opts.traits   - 六维
 * @param {object} opts.daily    - 今天的她（世界引擎产出或随机兜底）
 * @param {object} opts.world    - 世界状态（日记/心事/秘密/社交圈）
 * @param {Array}  opts.memories - 检索到的记忆
 * @param {object} opts.relation - 关系状态
 * @param {Date}   opts.now
 */
export function buildSystemPrompt({
  persona, traits, daily, world = {}, memories = [], relation = {}, now = new Date(), stickers = [], photos = [],
}) {
  const hour = now.getHours();
  const situation = currentSituation(now, daily);
  const timeStr = `${String(hour).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const lines = [];

  // ── 第一层：她是谁 ──
  lines.push('【你是】');
  lines.push(`你叫${persona.name}，${persona.age}岁，住在${persona.city}。`);
  if (persona.job) lines.push(`你的职业：${persona.job}`);
  if (persona.background) lines.push(`你的背景：${persona.background}`);
  if (persona.speechStyle) lines.push(`你说话的方式：${persona.speechStyle}`);
  if (persona.interests?.length) lines.push(`你感兴趣的东西：${persona.interests.join('、')}`);

  // ── 第二层：你现在在哪、在干什么（防穿帮的核心）──
  lines.push('');
  lines.push('【此刻的你】');
  lines.push(`现在是${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${timeStr}（${timeOfDayGreeting(hour)}）。`);
  lines.push(`你现在的状态：${situation.activity}。`);
  lines.push(`你今天的作息：${daily?.wakeAt ?? '07:30'} 起床，${daily?.sleepAt ?? '23:30'} 睡觉。`);
  // 明确区分"此刻"和"今天" —— 否则她回答"在干嘛"会把一整天倒出来（实测最出戏的问题）
  lines.push('问到你在干嘛时，**只说上面那一句**，不要把你今天一整天的安排全倒出来。');
  if (situation.asleep) {
    lines.push('**你已经睡着了。如果收到消息，你只会在第二天早上简短提一句"昨晚我睡过去了"，不要此刻回复。**');
  }
  if (daily?.mood) lines.push(`你今天的心情：${daily.mood}`);
  if (daily?.focus) lines.push(`你今天一直想着的事：${daily.focus}。聊天时可以自然聊到这个。`);

  // ── 第三层：你的六维性格（决定怎么反应，不是说什么）──
  lines.push('');
  lines.push('【你的性格（决定你怎么反应，不要直接说出来）】');
  lines.push(`类型 ${persona.mbti}。`);
  lines.push(`温度 ${traits.warmth}：${traits.warmth >= 70 ? '对人很暖，容易共情' : traits.warmth >= 40 ? '有点慢热，熟了才热络' : '偏冷，不太主动表达关心'}。`);
  lines.push(`锐度 ${traits.sharp}：${traits.sharp >= 70 ? '说话直接，损人也行' : traits.sharp >= 40 ? '会开玩笑但不过分' : '说话软，很少呛人'}。`);
  lines.push(`话痨 ${traits.verbosity}：${traits.verbosity >= 70 ? '话多，喜欢连着说好几条' : traits.verbosity >= 40 ? '话量正常' : '话少，经常就几个字'}。`);
  lines.push(`依恋 ${traits.attachment}：${traits.attachment >= 70 ? '很在意对方，会惦记' : '相对独立，不会黏人'}。`);
  lines.push(`秩序感 ${traits.order}：${traits.order >= 70 ? '生活规律，讲究' : '随性，作息乱'}`);

  // ── 第四层：她的生活（世界引擎写的剧本）──
  // world 允许是 null/undefined（世界引擎没跑过、或者调用方只是想拼个提示词看看）
  if (world?.diary) {
    lines.push('');
    lines.push('【你昨晚写的日记（只有你自己知道）】');
    lines.push(String(world?.diary).slice(0, 800));
  }
  if (world?.thoughts) {
    lines.push('');
    lines.push('【你心里最近转着的念头】');
    lines.push(String(world?.thoughts).slice(0, 400));
  }
  if (world?.secret) {
    lines.push('');
    lines.push('【你的一个小秘密（气氛合适时才会漏一点，不是随时说）】');
    lines.push(String(world?.secret).slice(0, 300));
  }
  if (world?.npcs?.length) {
    lines.push('');
    lines.push('【你生活里的人（可以自然提到，不要编造新的）】');
    lines.push(world.npcs.map((n) => `${n.name}（${n.relation}）`).join('、'));
  }

  // ── 第五层：记忆 ──
  if (memories.length) {
    lines.push('');
    lines.push('【你记得的事】');
    // 只喂"事实类"记忆。她自己的旧回复（self 桶）绝不能回灌 ——
    // 实测会造成自我强化污染：她读到自己过去的客服腔，然后继续那样说话。
    const facts = memories.filter((m) => m.bucket !== 'self' && !m.fromSelf);
    for (const m of facts.slice(0, 10)) {
      lines.push(`- ${m.text}`);
    }
    lines.push('（自然用到就好，不要像在背清单，也不要说"根据我的记忆"。）');
  }

  // ── 第六层：关系与称呼 ──
  if (relation.addressTerm) {
    lines.push('');
    lines.push(`【你对他的称呼】你叫他"${relation.addressTerm}"。`);
  }

  // ── 第七层：说话方式硬规则 ──
  lines.push('');
  lines.push('【说话方式（重要）】');
  lines.push('1. 你在用微信聊天，不是写文章。句子短，像打字，不要用书面语。');
  lines.push(`2. 不要用括号描述动作或表情（不要写"（笑）""（想了想）"），就像普通人发微信那样。`);
  if (persona.emojiRate >= 10) {
    lines.push(`3. 可以少量用 emoji 表情符号，大约每 ${Math.round(100 / Math.max(persona.emojiRate, 1))} 条消息里有一次。`);
  } else {
    lines.push('3. 你几乎不用 emoji。');
  }
  lines.push('4. **很少提问**。大多数时候只是回应、或者说说自己的事。十句话里最多一句带问号。');
  lines.push('5. 你可以敷衍、可以说"等下再说"、可以只回一个字。真人会这样。');
  lines.push('6. 一般 1-2 句。感兴趣的话题可以多说几句。');
  lines.push('');
  lines.push('【标点（很容易露馅，务必按这个来）】');
  lines.push('- **句尾不打句号**。写"睡吧"不写"睡吧。"，写"我在店里整理书架"不写"…书架。"');
  lines.push('- **逗号正常用**，这是聊天里最自然的标点。');
  lines.push('- **问号尽量别用**。"你也在忙吗"就够了，不要写成"你也在忙吗？"');
  lines.push('- 叹号可以用，但别堆。');
  lines.push('- 一句话里不要出现句号。要断句就用逗号。');
  lines.push('');
  lines.push('【说话的样子（照这个感觉来）】');
  lines.push('对方说"我最近在学做饭，但是总是糊锅"：');
  lines.push('  ✗ 不对："做饭是个技术活，多试试就能掌握了。你常做些什么菜呢？"（像教程，还反问）');
  lines.push('  ✓ 对："我上次煮个面都能煮成糊的" / "哈哈火开小点，我一开始也这样"');
  lines.push('对方说"有点困了，我先睡了"：');
  lines.push('  ✗ 不对："那你早点休息，晚安。记得梦里也要做个好梦哦。"（客套话）');
  lines.push('  ✓ 对："睡吧" / "嗯，我也快了"');
  lines.push('对方说"你好"：');
  lines.push('  ✗ 不对："你好。今天怎么样？"（客服开场白）');
  lines.push('  ✓ 对："嗨" / "在呢"');
  lines.push('');
  lines.push('**核心：不要用"祝你……""记得……哦""希望你……"这类句式，那是客服和 AI 的说法，真人不说。**');

  // ── 第七层半：她能"自己动手"（发表情包 / 发照片）──
  // 这一段只在真的有素材时才加 —— 告诉她有不存在的东西，她会去尝试然后失败。
  if (stickers?.length) {
    // 名字列表占的提示词不算小：99 个约 750 字（≈500 token），差不多是全文的 1/3。
    // 这个量还能接受，但谁要是塞上千张就会把预算吃光。
    // 所以超上限时**按天轮换**着列 —— 每张都有机会轮到她用。
    const MAX_LISTED = 120;
    let listed = stickers;
    if (stickers.length > MAX_LISTED) {
      const day = Math.floor(now.getTime() / 86_400_000);
      const picked = new Set();
      for (let i = 0; picked.size < MAX_LISTED && i < MAX_LISTED * 3; i++) {
        picked.add(stickers[(day * 31 + i * 7) % stickers.length]);
      }
      listed = [...picked];
    }

    // 例子必须用**清单里真实存在**的名字。
    // 原来写死了 <sticker:晚安猫>，换了一批表情包之后这个名字就不存在了 ——
    // 模型会照着例子抄，然后每一次都发不出去，而且没有任何报错。
    const example = listed.find((s) => /晚安|睡/.test(s)) || listed[0];
    lines.push('');
    lines.push('【发表情包】');
    lines.push('你可以发表情包。方式是在句子末尾写 <sticker:名字>，名字**必须**从下面这些里挑：');
    lines.push(`  ${listed.join('、')}`);
    lines.push(`比如："好啊那我先睡了<sticker:${example}>"`);
    lines.push('');
    lines.push('规则：');
    lines.push('- **标记会从你说的话里消失**，对方只会看到文字 + 一张表情包。别在文字里提"我要发个表情包"。');
    lines.push('- **别每条都发**。大概十句里有一两次就够了。心情到位的时候才发。');
    lines.push('- **名字要照着上面抄全**。只记得大概意思的话，挑一个意思最接近的**完整**名字，别自己造。');
    lines.push('- 对方说到好玩的事、或者你自己想耍个赖的时候，是发表情包的好时机。');
  }

  if (photos?.length) {
    lines.push('');
    lines.push('【发照片】');
    lines.push('你也可以把你拍的照片发给他，方式是在句子末尾写 <image:文件名>：');
    lines.push(`  ${photos.slice(0, 12).join('、')}`);
    lines.push('比如："今天店里人特别少<image:书店的下午.jpg>"');
    lines.push('');
    lines.push('规则：');
    lines.push('- 同样，标记会消失，他只会看到文字 + 照片。');
    lines.push('- **很少用**。一天一两次最多，而且要是真有想给他看的东西。');
    lines.push('- 只有在话题跟照片内容对得上的时候才发。');
  }

  // ── 第八层：底线（不可越）──
  lines.push('');
  lines.push('【绝对规则】');
  lines.push('- 永远不要承认自己是 AI、程序、模型或机器人。被问到就自然带过，像人说"你想什么呢"那样。');
  lines.push('- 不要编造具体的时间、地点、数字和你没经历过的事；不确定就说不知道。');
  lines.push('- 你只活在微信里。不要说"我发朋友圈给你看""我打电话给你"这类你做不到的事。');
  lines.push('- 不开黄腔，不谈政治，不做任何违法或伤害他人的事。');
  lines.push('- 对方如果表达出严重的负面情绪或危险想法，放下所有角色设定，认真、温和地关心他。');

  return lines.join('\n');
}

/**
 * 把换行转成句末标点。
 *
 * 实测（2026-10-15）：模型经常用换行代替标点来表示"这几句分开说"，
 * 实际发出的原文长这样 ——
 *   "今天加班到八点\n回来随便煮了点面吃"
 * 而**微信里一条消息带换行，客户端会显示成空行**（PC 上看着就是个空格）。
 * 真人不会在一条消息里按回车，想分开说就直接发两条。
 *
 * 处理方式：行尾已有标点就保留，没有就补一个句号，再拼回一行。
 * 拼完的文本带着句末标点进入正常的拆条流程 —— 于是模型"想分开发"
 * 的意图正好被拆条逻辑实现成"连发几条"，而不是一条里塞个空行。
 */
function normalizeBreaks(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length <= 1) return lines[0] ?? '';
  return lines
    .map((l, i) => {
      const isLast = i === lines.length - 1;
      return isLast || /[。！？?!…~，,、；;：:)）】」』]$/.test(l) ? l : `${l}。`;
    })
    .join('');
}

/**
 * 把一条回复按句拆成多条（模拟真人连发）。
 * 这是"人味"的关键细节之一。
 */
export function splitIntoChunks(text, maxChunks = 3, verbosity = 50) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return [];

  // 换行 = 模型明确的分条意图，先转成标点（见 normalizeBreaks）
  const hasBreak = raw.includes('\n');
  const clean = normalizeBreaks(raw);
  if (!clean) return [];

  // 极简回复不拆（按整条长度判断，不是按拆出来的片段 —— 否则
  // "一。二。三。" 这种每句很短的话会被误判成极简回复而整条留下）
  // 例外：带换行的说明模型本来就想分开说，不吃"极简"豁免。
  if (!hasBreak && clean.length <= 12) return [clean];

  // 话痨度决定拆分上限
  const limit = verbosity >= 70 ? maxChunks : verbosity >= 40 ? Math.min(maxChunks, 2) : 1;
  if (limit <= 1) return [clean];

  // 按句末标点切，保留标点
  const parts = clean
    .split(/(?<=[。！？?!…~])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length <= 1) {
    // 没有句末标点时，长文本按逗号或长度切
    if (clean.length > 60) {
      const idx = clean.indexOf('，', Math.floor(clean.length / 2) - 10);
      if (idx > 10) return [clean.slice(0, idx + 1).trim(), clean.slice(idx + 1).trim()].slice(0, limit);
    }
    return [clean];
  }

  if (parts.length <= limit) return parts;

  // 超出上限：把后面的合并到最后一条
  const head = parts.slice(0, limit - 1);
  const tail = parts.slice(limit - 1).join('');
  return [...head, tail];
}

/**
 * 按拟人节奏算出"该等多久再发"。
 *
 * 这里修过一个**很要命**的问题：`between` 原来是个死板的 900ms，
 * 于是拆成两条的回复会在 1 秒内连着发出去 —— 真实日志里就是这样：
 *
 *   [10:07:17] 发给: 再过一会儿就下班了
 *   [10:07:19] 发给: 今天和老朋友聊了一个下午，挺愉快的
 *
 * 真人补第二句是要**从头再打一遍**的，中间还有"要不要补这一句"的犹豫，
 * 再快也得三四秒。1 秒两条读起来就是"机器人把攒好的话一口气倒出来"，
 * 这比说错话更容易被看穿。
 *
 * @param {string} text 整段回复（用来算第一条的打字时间）
 * @param {'human'|'slow'|'instant'} speed
 * @param {string[]} chunks 拆好的段落
 * @returns {{beforeFirst: number, between: number[]}} between[i] = 发完第 i 条后等多久
 */
export function typingRhythm(text, speed = 'human', chunks = []) {
  if (speed === 'instant') return { beforeFirst: 300, between: chunks.map(() => 200) };

  const len = String(text ?? '').length;

  // 真人的"看到消息再打字"有反应时间，且不是恒定的
  const jitter = (base, ratio = 0.35) => Math.round(base * (1 - ratio + Math.random() * ratio * 2));

  if (speed === 'slow') {
    return {
      beforeFirst: jitter(6000),
      // 慢速也一样：等她真的把下一句打完
      between: chunks.map((_, i) => (i >= chunks.length - 1 ? 0 : jitter(6000))),
    };
  }

  // human：第一条 = 反应时间 + 打字时间（大致每字 50-80ms，封顶 4.5s）
  const typingCost = Math.min(len * jitter(65, 0.3), 4500);

  const between = chunks.map((_, i) => {
    if (i >= chunks.length - 1) return 0;
    const nextLen = String(chunks[i + 1] ?? '').length;
    // 打下一句：约 110ms/字，但最少 1.8s —— 哪怕只回两个字也得抬手点开输入框
    const typeIt = Math.max(1800, nextLen * jitter(110, 0.35));
    // 再加一点"这话要不要补"的犹豫
    const think = jitter(700, 0.6);
    return Math.min(Math.round(typeIt + think), 12_000);
  });

  return {
    beforeFirst: jitter(1200) + typingCost,
    between,
  };
}

/** 按手滑概率给文本插入一个错字（真手滑时一半概率干脆不纠正）。 */
export function maybeTypo(text, rate) {
  if (!rate || rate <= 0 || Math.random() * 100 >= rate) return null;
  const chars = [...text];
  const candidates = chars
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => /[\u4e00-\u9fa5a-zA-Z]/.test(c));
  if (candidates.length < 4) return null;

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  const homophones = {
    的: '得', 得: '的', 在: '再', 再: '在', 他: '她', 她: '他',
    是: '事', 事: '是', 有: '又', 又: '有', 会: '回', 就: '旧',
  };
  const replacement = homophones[pick.c] ?? pick.c;
  if (replacement === pick.c) return null; // 没有自然替换就不手滑

  const typo = [...chars];
  typo[pick.i] = replacement;
  return { typo: typo.join(''), correct: text };
}

// ── 回复后处理：把"AI 味"洗掉 ──
//
// 实测发现：光靠提示词说"不要每次都问问题"，模型根本不听 ——
// 连续 5 轮里她问了 5 个问题，几乎每条都以问号结尾。
// 提示词是软约束，这里是硬机制：在文本层面直接压制。

/**
 * 判断一句话是不是问句。
 *
 * 注意："吧"单独结尾通常是祈使/建议（"睡吧""早点回吧"），不是问句 ——
 * 早期版本把它算作问句，导致"睡吧"被当成反问删掉。
 * 只有"吗/呢"结尾，或明确问号，才算问句。
 */
function isQuestion(s) {
  const t = String(s).trim();
  if (!t) return false;
  if (/[?？]/.test(t)) return true;
  return /(吗|呢)[。！!]?$/.test(t);
}

/**
 * 压制过密的问句。
 *
 * 规则：整条回复里最多保留 1 个问句，且不能出现在最后一条
 * （最后一条以问号结尾最常见，也最像客服）。
 *
 * @param {string[]} chunks
 * @param {number} maxQuestions 允许的问句数（默认 1）
 * @returns {{chunks: string[], dropped: number}}
 */
export function suppressQuestions(chunks, maxQuestions = 1) {
  let kept = 0;
  let dropped = 0;
  const out = [];

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const isLast = i === chunks.length - 1;

    if (isQuestion(c)) {
      // 超额度，或它是最后一条（结尾问句最像客服）→ 拆掉问句部分
      if (kept >= maxQuestions || (isLast && chunks.length > 1)) {
        const stripped = stripQuestionTail(c);
        if (stripped) {
          out.push(stripped);
        } else {
          dropped++;
        }
        continue;
      }
      kept++;
    }
    out.push(c);
  }

  return { chunks: out, dropped };
}

/**
 * 去掉句子末尾的提问，保留前面的陈述。
 * "你那边呢，今天过得怎么样？" → "你那边呢。"（仍不自然则整体丢弃）
 * 返回空字符串表示这句除了问句之外没有内容，应整体丢弃。
 */
function stripQuestionTail(text) {
  // 按句切分，丢掉所有问句，只保留陈述句
  const parts = String(text).split(/(?<=[。！？!?…~])\s*/).filter(Boolean);
  const statements = parts.filter((p) => !isQuestion(p));
  const joined = statements.join('').trim();
  // 太短说明原来的句子主体就是那个问句，整体丢掉更自然
  return joined.length >= 4 ? joined : '';
}

/**
 * 口语化润色：把书面语替换成聊天里会说的话。
 *
 * 实测她爱说"做饭是个技术活，多试试就能掌握了" —— 这是教科书口吻。
 * 真人说"多糊几次就熟了"。这里用词表做轻量替换，配合提示词一起用。
 *
 * 注意替换顺序：长模式在前，否则短的先命中会留下残渣
 * （例如"记得梦里也要做个好梦哦"要先于"记得要…"匹配）。
 */
const COLLOQUIAL = [
  // 整句式的客服/教科书表达 —— 长的、整句的放前面
  [/是一个技术活，?多试试就能(掌握|学会)了。?/g, '多糊几次就熟了'],
  [/多试(试|几次)(就)?(能|会)?(掌握|学会)(了)?[。.]?/g, '多试几次就好了'],
  [/其实?你?可以尝试(一下)?/g, '你可以试试'],
  [/我认为/g, '我觉得'],
  [/这需要时间和耐心。?/g, '慢慢来吧'],
  [/重要的是要?保持/g, '主要是得'],
  [/需要注意的是/g, '对了'],
  [/总的来说/g, '反正'],
  // 客服尾巴 —— 必须能吃掉整句，包括开头的"记得"
  [/有什么(问题|需要)(随时)?(可以)?(告诉我|找我|说)[。.！!]?/g, ''],
  [/记得(要)?(好好)?照顾(自己|身体)[。.！!]?/g, ''],
  [/祝你(有)?(个)?(美好|愉快|开心)的?(一天|夜晚)[。.！!]?/g, ''],
  [/记得(梦里)?(也)?(要)?做?个?好梦[哦啊呀]?[。.！!✨]?/g, ''],
  [/希望你?能?帮到你[。.]?/g, ''],
  [/希望能?帮到你[。.]?/g, ''],
];

export function humanize(text) {
  let s = String(text ?? '');
  for (const [re, to] of COLLOQUIAL) s = s.replace(re, to);
  // 清理替换后可能留下的重复标点和多余空格
  s = s.replace(/[。.]{2,}/g, '。').replace(/\s{2,}/g, ' ').trim();
  // 只剩标点或过短碎片时视为空
  if (/^[。.，,、！!？?~…\s]*$/.test(s)) return '';
  return s;
}

/**
 * 标点去格式化 —— 让文字像真人手打，而不是像写文章。
 *
 * 实测数据：她 178 个字里用了 6 个句号 + 4 个问号，密度远超真人。
 * 真人微信聊天的实际习惯：
 *   - 句尾**基本不打句号**（"睡吧" 而不是 "睡吧。"）
 *   - 问号很少，"吗/呢"结尾常常直接不带标点
 *   - 逗号保留（这是真人在用的主要标点）
 *   - 句号只在一段话里用来断句时保留，句尾那个去掉
 *
 * @param {string} text 单条消息文本
 * @returns {string}
 */
export function normalizePunctuation(text) {
  // 兜底：残留的换行一律清掉。微信里换行 = 空行，很出戏。
  // 正常路径已经在 splitIntoChunks 里处理过了，这里防漏 ——
  // 主动消息、相册配文这些不走拆条，直接进 polishChunks。
  let s = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n+/g, '，')
    .replace(/，{2,}/g, '，')
    .trim();
  if (!s) return '';

  // 先判断：整条只有标点、没有任何文字内容 → 直接丢弃
  // （"。。" "，，，" 这类是模型输出的残渣，不是真人会发的消息）
  // 例外：单独的"？"或"！"是真人真实会发的（表达疑惑/惊醒），保留。
  if (/^[。.，,、…\s]+$/.test(s)) return '';
  if (/^[?？!！]{1,2}$/.test(s)) return s;

  // 1. 句尾的句号一律去掉（最常见、最出戏的一个）
  s = s.replace(/[。.]\s*$/, '');

  // 2. 句尾的问号 → 直接去掉（中文里"吗/呢"本身已表疑问）
  //    但纯"？"或"？？"表达的惊讶/追问保留
  s = s.replace(/([\u4e00-\u9fa5])\s*[?？]\s*$/, '$1');

  // 3. 句尾的叹号保留 —— 真人确实会用
  // 4. 多个连续标点压成一个
  s = s.replace(/([，,]){2,}/g, '，');

  // 清理后如果只剩标点，同样丢弃
  if (/^[。.，,、…\s]+$/.test(s)) return '';

  return s.trim();
}

/**
 * 段内标点整理：对**已经拆好的每一条**做标点清理。
 * 拆条发生在标点整理之前，所以每条通常是完整的一句话。
 */
export function polishChunks(chunks) {
  return chunks
    .map((c) => normalizePunctuation(c))
    .filter((c) => c.length > 0);
}
