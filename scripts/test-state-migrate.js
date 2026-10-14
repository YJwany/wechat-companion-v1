import { Companion } from '../src/companion.js';

const KEY = 'probe-落盘测试';
let pass = 0, fail = 0;
const check = (n, c) => { if (c) { console.log('  ✓ ' + n); pass++; } else { console.log('  ✗ ' + n); fail++; } };

const c = new Companion();
check('state.reunions 是对象', typeof c.state.reunions === 'object' && c.state.reunions !== null);
check('账本与 state 同一对象（不再是游离的 {}）', c.state.reunions === c.reunion.state);

c.reunion.settle(KEY);
check('settle 写进了 state', !!c.state.reunions[KEY]);

c.saveState();
const c2 = new Companion();
check('★ 重启后读得到（能落盘了）', !!c2.reunion.state[KEY]);

// 更重要的：重启后重逢**不会重复提**
c2.reunion.settle('peer-x');
const r = c2.reunion.check('peer-x', 48);
check('刚结算过 → 不再结算（不会反复提）', !r.settle);

const r2 = c2.reunion.check('peer-y', 48);
check('换了个人 → 该结算', r2.settle);

// 清理
delete c2.state.reunions[KEY];
delete c2.state.reunions['peer-x'];
c2.saveState();

console.log('');
console.log(`通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
