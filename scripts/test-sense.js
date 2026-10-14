// 常识检查：本地规则要准（不误报、不漏报），提示词要真的写进约束。
import { checkCommonSense, commonSenseBlock, selfCheckHint, buildSelfCheckPrompt } from '../src/soul/sense.js';

let pass = 0, fail = 0;
const check = (n, c, extra = '') => {
  if (c) { console.log(`  ✓ ${n}`); pass++; }
  else { console.log(`  ✗ ${n} ${extra}`); fail++; }
};

/** 造一个指定时间的 Date。 */
const at = (h, m = 0, day = 3) => {
  const d = new Date(2026, 8, 16);       // 2026-09-16 是周三
  d.setDate(d.getDate() + (day - d.getDay()));
  d.setHours(h, m, 0, 0);
  return d;
};
const WED = 3, SUN = 0;

console.log('一、穿帮要抓到');
console.log('─'.repeat(64));
{
  let r = checkCommonSense('我刚从银行出来', { now: at(2) });
  check('★ 凌晨两点刚从银行出来（经典穿帮）', r.suspect, JSON.stringify(r.issues));

  r = checkCommonSense('我在银行办点事', { now: at(3) });
  check('凌晨三点在银行', r.suspect);

  r = checkCommonSense('刚从法院出来', { now: at(23) });
  check('半夜从法院出来', r.suspect);

  r = checkCommonSense('我去车管所办个事', { now: at(11, 0, SUN) });
  check('★ 周末去车管所', r.suspect, JSON.stringify(r.issues));

  r = checkCommonSense('我在银行办卡', { now: at(11, 0, SUN) });
  check('周末在银行', r.suspect);

  r = checkCommonSense('我还在开会', { now: at(1) });
  check('凌晨一点还在开会', r.suspect);

  r = checkCommonSense('我刚从银行回来', { now: at(20) });
  check('晚上八点刚从银行回来（17点就关门）', r.suspect, JSON.stringify(r.issues));
}

console.log('');
console.log('二、正常的不能误报 —— 误报比漏报更烦人');
console.log('─'.repeat(64));
{
  let r = checkCommonSense('我刚从银行回来', { now: at(15) });
  check('★ 下午三点从银行回来 → 正常', !r.suspect, JSON.stringify(r.issues));

  r = checkCommonSense('我在公司写代码', { now: at(14) });
  check('下午两点在公司 → 正常', !r.suspect);

  r = checkCommonSense('我明天想去银行办点事', { now: at(23) });
  check('★ 深夜说"明天想去银行" → 正常（是打算，不是在那儿）', !r.suspect, JSON.stringify(r.issues));

  r = checkCommonSense('打算周末去银行', { now: at(23) });
  check('深夜说"打算周末去" → 正常', !r.suspect);

  r = checkCommonSense('今天好累啊', { now: at(2) });
  check('深夜说累 → 正常', !r.suspect);

  r = checkCommonSense('我在家躺着呢', { now: at(2) });
  check('凌晨在家躺着 → 正常', !r.suspect);

  r = checkCommonSense('我在看书', { now: at(15) });
  check('下午看书 → 正常', !r.suspect);

  r = checkCommonSense('', { now: at(3) });
  check('空字符串不报', !r.suspect);
  r = checkCommonSense(null, { now: at(3) });
  check('null 不崩', !r.suspect);
}

console.log('');
console.log('三、提示词里的约束');
console.log('─'.repeat(64));
{
  const b = commonSenseBlock({ now: at(15, 30, WED) });
  check('写了银行营业时间', /银行.*9:00-17:00/.test(b));
  check('写了周末不办公', /周末/.test(b));
  check('★ 说了"不能同时出现在两个地方"', /不能同时出现在两个地方/.test(b));
  check('说了睡觉时不会回消息', /睡着了不会回消息/.test(b));
  check('禁止编具体数字', /别编具体数字/.test(b));
  check('带了当前时间', /15:30/.test(b));
  check('带了星期', /周三/.test(b));

  const we = commonSenseBlock({ now: at(15, 30, SUN) });
  check('★ 周末会额外提醒"今天是周末"', /今天是周末/.test(we), '（不该出现在工作日）');
  const wk = commonSenseBlock({ now: at(15, 30, WED) });
  check('工作日不会说"今天是周末"', !/今天是周末/.test(wk));

  const night = commonSenseBlock({ now: at(2, 0, WED) });
  check('★ 深夜会额外提醒"现在是深夜"', /现在是深夜/.test(night));
  const day = commonSenseBlock({ now: at(14, 0, WED) });
  check('白天不会说"现在是深夜"', !/现在是深夜/.test(day));

  const withFlow = commonSenseBlock({ now: at(14), daily: { flow: '上午去了书店，下午在家' } });
  check('带了她的生活流水', /上午去了书店/.test(withFlow));
}

console.log('');
console.log('四、自检提示词');
console.log('─'.repeat(64));
{
  const h = selfCheckHint(['凌晨不可能在开会']);
  check('列出了问题', /凌晨不可能在开会/.test(h));
  check('要求直接换一句', /直接换一句/.test(h));
  check('★ 明确说了别道歉（否则她会写检讨）', /别道歉/.test(h));
  check('要求保持语气长度', /同样的语气|语气和长度/.test(h));
  check('没问题时返回空串', selfCheckHint([]) === '' && selfCheckHint(null) === '');

  const p = buildSelfCheckPrompt('我在银行', { now: at(3), issues: ['银行没开门'] });
  check('带上了原句', /我在银行/.test(p));
  check('带上了问题清单', /银行没开门/.test(p));
  check('要求只输出那句话', /只输出那句话本身/.test(p));
  check('带上了常识背景', /这个世界怎么运转/.test(p));
}

console.log('');
console.log('五、边界：不能崩');
console.log('─'.repeat(64));
{
  const weird = [undefined, null, '', 0, {}, [], 'a'.repeat(3000), '🚀'.repeat(100)];
  let ok = true;
  for (const w of weird) {
    try {
      const r = checkCommonSense(w, { now: at(3) });
      if (!Array.isArray(r.issues)) ok = false;
    } catch { ok = false; }
  }
  check('★ 各种奇怪输入都不抛错', ok);

  let blockOk = true;
  for (const w of [undefined, null, {}, { flow: null }, { flow: 'x' }]) {
    try { commonSenseBlock({ now: at(3), daily: w }); } catch { blockOk = false; }
  }
  check('commonSenseBlock 对奇怪 daily 也不崩', blockOk);
}

console.log('');
console.log('═'.repeat(64));
console.log(`通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
