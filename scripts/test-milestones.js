// 验证纪念日引擎。
import {
  daysTogether, checkMilestone, milestoneHint, MilestoneLedger, MILESTONES,
} from '../src/soul/milestones.js';

let pass = 0, fail = 0;
const check = (n, c, extra = '') => {
  if (c) { console.log(`  ✓ ${n}`); pass++; }
  else { console.log(`  ✗ ${n} ${extra}`); fail++; }
};

const NOW = new Date('2026-09-19T12:00:00+08:00');
const daysAgo = (d) => new Date(NOW.getTime() - d * 86_400_000);

console.log('一、天数计算');
console.log('─'.repeat(64));
check('0 天', daysTogether(daysAgo(0), NOW) === 0);
check('1 天', daysTogether(daysAgo(1), NOW) === 1);
check('100 天', daysTogether(daysAgo(100), NOW) === 100);
check('未来时间不返回负数', daysTogether(daysAgo(-5), NOW) === 0);
check('非法输入不炸', daysTogether('不是时间', NOW) === 0);
check('差一点到一天也算 0', daysTogether(new Date(NOW.getTime() - 3600_000), NOW) === 0);

console.log('');
console.log('二、节点判定');
console.log('─'.repeat(64));
check('第 7 天命中', checkMilestone(daysAgo(7), NOW)?.days === 7);
check('第 100 天命中', checkMilestone(daysAgo(100), NOW)?.days === 100);
check('第 365 天命中且是大节点', checkMilestone(daysAgo(365), NOW)?.big === true);
check('第 730 天 = 2 年', checkMilestone(daysAgo(730), NOW)?.label === '认识 2 年',
  checkMilestone(daysAgo(730), NOW)?.label);
check('普通一天不命中', checkMilestone(daysAgo(42), NOW) === null);
check('第 0 天不命中（还没认识）', checkMilestone(daysAgo(0), NOW) === null);
check('★ 昨天是 100 天，今天不补提', checkMilestone(daysAgo(101), NOW) === null,
  '补提会像日历提醒，不像记忆');

console.log('');
console.log('三、每个节点只提一次');
console.log('─'.repeat(64));
{
  const led = new MilestoneLedger({});
  const r1 = led.check(daysAgo(100), NOW);
  check('第一次：该提', r1.fire);
  check('带上节点信息', r1.milestone?.days === 100);

  led.mark(100);
  const r2 = led.check(daysAgo(100), NOW);
  check('★ 提过之后不再提', !r2.fire);

  const r3 = led.check(daysAgo(365), NOW);
  check('别的节点不受影响', r3.fire);
  check('done() 记录了 100', led.done().includes(100));
}
{
  const led = new MilestoneLedger({});
  check('不是节点日就不提', !led.check(daysAgo(42), NOW).fire);
}

console.log('');
console.log('四、下一个节点');
console.log('─'.repeat(64));
{
  const led = new MilestoneLedger({});
  const n = led.next(daysAgo(50), NOW);
  check('第 50 天时下一个是 100', n.days === 100 && n.inDays === 50,
    JSON.stringify(n));
  const n2 = led.next(daysAgo(1200), NOW);
  check('超过最后一个节点按整年推', n2.days > 1200 && Number.isInteger(n2.days / 365),
    JSON.stringify(n2));
}

console.log('');
console.log('五、提示词的分寸（这是容易做砸的地方）');
console.log('─'.repeat(64));
{
  const small = milestoneHint({ days: 100, label: '认识 100 天', big: false });
  check('小节点要求轻轻带过', /轻轻带过/.test(small));
  check('小节点明确禁用"纪念日"这个词', /不要用"纪念日"/.test(small));

  const big = milestoneHint({ days: 365, label: '认识 1 年', big: true });
  check('大节点允许正经一点', /正经一点/.test(big));
  check('大节点也禁止贺卡腔', /贺卡/.test(big));

  const cold = milestoneHint({ days: 100, big: false }, { relation: { messageCount: 3 } });
  check('聊得很少时不自作多情', /没怎么聊过/.test(cold));
  const warm = milestoneHint({ days: 100, big: false }, { relation: { messageCount: 500 } });
  check('聊得多时不加那句', !/没怎么聊过/.test(warm));

  check('没有节点时返回空串', milestoneHint(null) === '');
}

console.log('');
console.log('═'.repeat(64));
console.log(`通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
