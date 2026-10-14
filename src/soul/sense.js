// 常识：让她说出来的话经得起推敲。
//
// 起因：参考项目的用户原话是"此人显然极度缺少常识" ——
// 她会在凌晨三点说"我刚从银行出来"，会在周日说"今天去公司开会但财务没上班"。
// 这类穿帮比说错话更致命，因为它一句话就暴露了"这不是人"。
//
// 四层（参考项目的做法）我们做三层，第三层做了取舍：
//   ① 此刻唯一答案 —— 她只能知道"现在这一秒"（已有：currentSituation）
//   ② 常识底线清单 —— 写进提示词，告诉她这个世界怎么运转（本文件）
//   ③ 发前自检 —— **本地先查（免费、必跑）**，可疑了才调模型复核
//   ④ 说话挂在她的生活上（已有：世界引擎流水）
//
// 为什么第③层要分两步：每条消息都调模型自检 = 每条消息都多花 1-3 秒 + 一次调用。
// 而实际上 95% 的回复根本没问题。所以先用本地规则捞可疑的，再花模型的钱。

/** 有固定作息的地方：这些地方**只在特定时间开门**。 */
const PLACE_HOURS = [
  { re: /银行|柜台|开户|办卡/, name: '银行', open: 9, close: 17, weekdaysOnly: true },
  { re: /法院|开庭|诉讼/, name: '法院', open: 9, close: 17, weekdaysOnly: true },
  { re: /医院|挂号|门诊|体检/, name: '医院门诊', open: 8, close: 17, weekdaysOnly: false },
  { re: /邮局|邮政|寄快递|取快递/, name: '邮局', open: 9, close: 18, weekdaysOnly: false },
  { re: /政务|办事大厅|不动产|社保局|车管所/, name: '政务大厅', open: 9, close: 17, weekdaysOnly: true },
  { re: /学校|上课|教室|图书馆/, name: '学校', open: 8, close: 21, weekdaysOnly: false },
  { re: /公司|上班|工位|开会|办公室/, name: '公司', open: 8, close: 20, weekdaysOnly: true },
  { re: /超市|商场|逛街/, name: '商场', open: 9, close: 22, weekdaysOnly: false },
  { re: /健身房|游泳馆/, name: '健身房', open: 7, close: 23, weekdaysOnly: false },
];

/**
 * 绝对不可能的组合 —— **与时间无关**的那些。
 *
 * 曾经这里还有两条（"刚从银行出来"、"在开会+凌晨"）——
 * 它们和当前时间有关，放在这里会在下午三点误报"刚从银行出来"。
 * 那两条已并入下面的营业时间检查。
 */
const IMPOSSIBLE = [
  { re: /(睡|躺|住).{0,4}(在)?(公司|学校|银行|法院)内?/, why: '她不会睡在公司/银行这种地方' },
  { re: /(凌晨|半夜).{0,6}(去|在)?(银行|法院|车管所|政务)/, why: '这些地方半夜不可能开门' },
];

/**
 * "这是打算、不是此刻在做"的表达。
 *
 * 为什么必须有：她深夜说"我明天想去银行办点事"完全正常，
 * 但字面上出现了"银行"，会被营业时间检查误伤。
 * 误报比漏报更烦人 —— 每次误报都要多花一次模型调用去"复核"一句本来没问题的话。
 */
const FUTURE_RE = /(明天|后天|大后天|改天|下次|下回|晚点|待会|一会儿|打算|准备|计划|想去|要去|周末去|以后|回头)/;

/** 把 "HH:MM" 转成分钟。 */
function toMin(hhmm) {
  const [h, m] = String(hhmm ?? '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * 常识底线清单 —— 直接进提示词。
 *
 * 写法上刻意用"这个世界怎么运转"而不是"你不许"：
 * 禁令式提示词会让模型变得畏手畏脚，描述式不会。
 */
export function commonSenseBlock({ daily, now = new Date() } = {}) {
  const hour = now.getHours();
  const weekend = [0, 6].includes(now.getDay());
  const dayName = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];

  const lines = [
    '【这个世界怎么运转的（别穿帮）】',
    `现在是 ${dayName} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}。`,
    '',
    '有些地方是按点开门的，你要出门办事得看时间：',
    '· 银行、法院、政务大厅、车管所：工作日 9:00-17:00，周末和节假日不开门',
    '· 医院门诊：8:00-17:00，急诊随时',
    '· 邮局、快递点：9:00-18:00',
    '· 超市商场：9:00-22:00',
    '· 健身房：7:00-23:00',
    '',
    '几条硬道理：',
    '· 你**正在做的事**必须和现在的时间对得上 —— 凌晨三点不会有人在开会、逛街、办业务',
    '· 你**不能同时出现在两个地方**：说在家就在家，别下一句又从外面回来',
    '· 睡觉时间就是睡觉，睡着了不会回消息',
    '· 周日不要提"公司财务/人事没上班"这种要去公司才发现的事',
    '· 不确定的事就说"不太清楚"，**别编具体数字**（价格、门牌号、车牌、电话）',
    '· 天气、新闻这类你没法确认的事，别用肯定句',
  ];

  if (weekend) {
    lines.push('· **今天是周末**，大多数上班的地方都不开，你也不用上班');
  }
  if (hour >= 23 || hour < 6) {
    lines.push('· **现在是深夜**，正常人都在睡觉，你要是醒着只能是家里蹲着刷手机');
  }

  if (daily?.flow) {
    lines.push('', '你今天大概是这样过的（你说的话要能挂在这上面）：');
    lines.push(`· ${String(daily.flow).slice(0, 200)}`);
  }

  return lines.join('\n');
}

/**
 * 本地常识检查 —— 免费、必跑。
 *
 * @returns {{issues: string[], suspect: boolean}}
 */
export function checkCommonSense(text, { daily, now = new Date() } = {}) {
  const t = String(text ?? '');
  const issues = [];
  if (!t) return { issues, suspect: false };

  const hour = now.getHours();
  const minutes = hour * 60 + now.getMinutes();
  const weekend = [0, 6].includes(now.getDay());
  const dayName = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];

  // "我明天想去银行"说的是打算，不是此刻在那儿 —— 这类一律不查。
  const isFuture = FUTURE_RE.test(t);

  // 1) 地点 + 营业时间
  if (!isFuture) {
    for (const p of PLACE_HOURS) {
      if (!p.re.test(t)) continue;
      // 只有"她在那"的口吻才算
      const isThere = /(刚|我|在|去|从|到|正在)/.test(t);
      if (!isThere) continue;

      const before = minutes < p.open * 60;
      const after = minutes >= p.close * 60;
      if (before || after) {
        issues.push(`${p.name}这个点不开门（${p.open}:00-${p.close}:00），但你说你此刻在那儿`);
      } else if (weekend && p.weekdaysOnly) {
        issues.push(`${p.name}周末不开门，但今天是${dayName}`);
      }
    }
  }

  // 2) 与时间无关的绝对矛盾
  for (const imp of IMPOSSIBLE) {
    if (imp.re.test(t)) issues.push(imp.why);
  }

  // 3) 深夜还在忙活
  if (!isFuture && (hour >= 23 || hour < 6)
      && /(在|正在)?(开会|上班|逛街|办事|银行|公司|法院|车管所)/.test(t)) {
    issues.push(`现在是${hour}点，正常人在睡觉，你不可能还在开会/上班/办事`);
  }

  return { issues: [...new Set(issues)], suspect: issues.length > 0 };
}

/** 把本地查出的问题转成"让她自己复核"的提示词。 */
export function selfCheckHint(issues) {
  if (!issues?.length) return '';
  return [
    '【你刚才这句话有常识问题，改一下再说】',
    '系统检查发现：',
    ...issues.map((i) => `· ${i}`),
    '',
    '按下面的方式改：',
    '· **别解释，别道歉，直接换一句说得通的**',
    '· 如果这件事这个点确实做不了，就换成你此刻真在做的事',
    '· 保持原来的语气和长度，只把说不通的地方改掉',
  ].join('\n');
}

/** 给模型看的复核提示词（本地查出问题后才调）。 */
export function buildSelfCheckPrompt(text, { daily, now = new Date(), issues = [] } = {}) {
  return [
    commonSenseBlock({ daily, now }),
    '',
    '---',
    `你刚才想说：「${String(text).slice(0, 300)}」`,
    '',
    issues.length ? `这句话有问题：\n${issues.map((i) => `· ${i}`).join('\n')}` : '请自己检查这句话有没有常识问题。',
    '',
    '如果有问题，**直接给出改好的那句话**（同样的人、同样的语气、同样的长度）。',
    '如果没问题，原样重复一遍那句话。',
    '只输出那句话本身，不要任何解释、不要引号。',
  ].join('\n');
}
