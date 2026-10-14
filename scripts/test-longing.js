// 验证想念曲线的**形状**（这是核心，不是细节）。
import { longingLevel, reunionTone, reunionHint, ReunionLedger, PEAK_HOURS, SETTLE_HOURS } from '../src/soul/longing.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name} ${extra}`); fail++; }
};

console.log('一、曲线形状：先升后降');
console.log('─'.repeat(66));
console.log('   时长      想念强度');
for (const h of [0, 2, 3, 5, 8, 11, 14, 20, 30, 48, 72, 168, 720]) {
  const lv = longingLevel(h);
  const bar = '█'.repeat(Math.round(lv * 30));
  const label = h < 24 ? `${h}h` : `${(h / 24).toFixed(0)}天`;
  console.log(`   ${label.padStart(6)}    ${lv.toFixed(2)} ${bar}`);
}

const peak = longingLevel(PEAK_HOURS);
const at8 = longingLevel(8);
const at48 = longingLevel(48);
const at72 = longingLevel(SETTLE_HOURS);
const at30d = longingLevel(720);

check('刚聊完时不想念', longingLevel(1) === 0);
check('随时间上升', at8 > longingLevel(5));
check('在峰值处最高', peak === 1);
check('过了峰值开始下降', at48 < peak, `${at48.toFixed(2)} 应 < 1`);
check('降到 72 小时基本到底', at72 < 0.2, `实际 ${at72.toFixed(2)}`);
check('一周后还是低于峰值（不是越久越黏）', longingLevel(168) < peak);
check('一个月后不再增长', Math.abs(at30d - longingLevel(168)) < 0.01,
  `168h=${longingLevel(168).toFixed(3)} 720h=${at30d.toFixed(3)}`);

// 这是整个模块最关键的一条
check('★ 消失一天比消失一周更想你', longingLevel(24) > longingLevel(168),
  `24h=${longingLevel(24).toFixed(2)} vs 168h=${longingLevel(168).toFixed(2)}`);

console.log('');
console.log('二、异常输入不能炸');
console.log('─'.repeat(66));
check('负数 → 0', longingLevel(-5) === 0);
check('NaN → 0', longingLevel(NaN) === 0);
check('undefined → 0', longingLevel(undefined) === 0);
check('Infinity 不返回 NaN', Number.isFinite(longingLevel(Infinity)));

console.log('');
console.log('三、重逢语气分档');
console.log('─'.repeat(66));
check('刚聊完 → none', reunionTone(2) === 'none');
check('半天 → none（不至于提）', reunionTone(8) === 'none');
check('一天 → brief', reunionTone(20) === 'brief');
check('两天 → long', reunionTone(48) === 'long');
check('一周以上 → veryLong', reunionTone(24 * 10) === 'veryLong');
check('none 不产生提示', reunionHint('none', 2) === '');
check('brief 有提示', reunionHint('brief', 20).length > 0);
check('veryLong 要求语气淡', /淡一点|漫不经心/.test(reunionHint('veryLong', 24 * 10)));
check('long 明确说不要抱怨', /不要抱怨/.test(reunionHint('long', 48)));

console.log('');
console.log('四、重逢只结算一次（关键的"不折磨人"机制）');
console.log('─'.repeat(66));
{
  const store = {};
  const led = new ReunionLedger(store);
  const peer = 'u1';

  const a = led.check(peer, 48);
  check('第一次：该结算', a.settle);
  check('语气是 long', a.tone === 'long');

  led.settle(peer);

  const b = led.check(peer, 48);
  check('★ 紧接着再问：不结算了（不会反复提）', !b.settle);

  // 模拟很久以后又失联
  store[peer] = new Date(Date.now() - 10 * 3_600_000).toISOString();
  const c2 = led.check(peer, 48);
  check('10 小时后再次失联 → 可以再结算', c2.settle);
}
{
  const led = new ReunionLedger({});
  check('没失联就不结算', !led.check('u2', 1).settle);
}
{
  const led = new ReunionLedger({});
  led.settle('u3');
  check('settle 写入账本', led.stats().count === 1);
}

console.log('');
console.log('═'.repeat(66));
console.log(`通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
