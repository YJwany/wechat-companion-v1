// 验证"昨晚我断片了"真的走得通了。
//
// 背景：这段提示词一直写在 persona.js 里，但 shouldReply 在她睡着时提前 return，
// 那段提示词永远拼不进 prompt —— 是个"写了但走不到"的死路径。
import { Companion } from '../src/companion.js';
import { SleepLedger, sleepHint } from '../src/soul/sleep.js';
import { currentSituation } from '../src/soul/persona.js';

let pass = 0, fail = 0;
const check = (n, c, extra = '') => {
  if (c) { console.log(`  ✓ ${n}`); pass++; }
  else { console.log(`  ✗ ${n} ${extra}`); fail++; }
};

console.log('一、账本本身');
console.log('─'.repeat(64));
{
  const led = new SleepLedger({});
  check('没记录时不该提', led.pending('u1') === null);

  led.note('u1');
  const p = led.pending('u1');
  check('记一笔后该提', !!p);
  check('次数记为 1', p?.times === 1);
  check('时长接近 0', p?.hours < 0.1);

  led.note('u1');
  check('再记一次次数累加', led.pending('u1')?.times === 2, `实际 ${led.pending('u1')?.times}`);

  led.clear('u1');
  check('提过之后不再提', led.pending('u1') === null);
}
{
  const led = new SleepLedger({});
  led.note('u2', new Date(Date.now() - 20 * 3_600_000));
  check('★ 20 小时前的记录不再翻出来（那是前天了）', led.pending('u2') === null,
    JSON.stringify(led.pending('u2')));
}
{
  const led = new SleepLedger({});
  led.note('u3', new Date(Date.now() - 8 * 3_600_000));
  check('8 小时前（就是昨晚）该提', !!led.pending('u3'));
}

console.log('');
console.log('二、提示词的分寸');
console.log('─'.repeat(64));
{
  const h = sleepHint({ times: 1, hours: 8 });
  check('要求顺口提一句', /顺口提一句/.test(h));
  check('★ 明确说不要道歉（真人睡过去不写检讨）', /不要道歉/.test(h));
  check('明确说一句就够', /一句/.test(h));
  check('没有次数时不啰嗦', !/找了 1 次/.test(h));
}
{
  const h = sleepHint({ times: 5, hours: 8 });
  check('被找过多次会说明次数', /找了 5 次/.test(h));
}
check('没记录时返回空串', sleepHint(null) === '');

console.log('');
console.log('三、接线：睡着时记账 → 醒来时消费一次');
console.log('─'.repeat(64));
{
  const c = new Companion();
  const PEER = 'peer-sleep-wire';
  delete c.state.sleepNote?.[PEER];
  c.sleep.state = c.state.sleepNote;

  // 模拟两段：睡着时被找 2 次
  c.sleep.note(PEER);
  c.sleep.note(PEER);
  const st = c.sleep.stats();
  check('账本记到了', st.count >= 1);

  const pend = c.sleep.pending(PEER);
  check('醒来时有待提的事', !!pend);
  check('次数是 2', pend?.times === 2);

  // 消费一次
  const hint = sleepHint(pend);
  c.sleep.clear(PEER);
  check('提示词非空', hint.length > 0);
  check('★ 消费后不再提（不会连着好几轮说）', c.sleep.pending(PEER) === null);

  // 落盘
  c.saveState();
  const c2 = new Companion();
  check('落盘后 told 状态保持', c2.sleep.pending(PEER) === null);

  delete c2.state.sleepNote[PEER];
  c2.saveState();
  delete c.state.sleepNote[PEER];
  c.saveState();
}

console.log('');
console.log('四、她此刻到底睡没睡（接线依赖这个）');
console.log('─'.repeat(64));
{
  const c = new Companion();
  const daily = c.soul.todayFor();
  const s = currentSituation(new Date(), daily);
  console.log(`  她今天的作息: ${daily.wakeAt} 起 / ${daily.sleepAt} 睡`);
  console.log(`  现在（本地 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}）: ${s.asleep ? '睡着' : '醒着'}`);
  check('isAsleep() 能用', typeof c.soul.isAsleep() === 'boolean');
  check('和 currentSituation 一致', c.soul.isAsleep() === !!s.asleep);
}

console.log('');
console.log('═'.repeat(64));
console.log(`通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
