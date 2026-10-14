// 验证承诺账本：抓得准、到期会提、过期不再提。
import { extractPromises, inferDueAt, PromiseLedger } from '../src/soul/promises.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name} ${extra}`); fail++; }
};

console.log('一、从她的回复里抓承诺');
console.log('─'.repeat(64));
const cases = [
  ['我明天告诉你结果', true],
  ['等我查查那本书有没有', true],
  ['我一会儿发你', true],
  ['我记一下，回头提醒你', true],
  ['改天给你看我拍的照片', true],
  // 这些**不该**被当成承诺
  ['今天天气不错', false],
  ['我在看书', false],
  ['明天是周末呀', false],
  ['哈哈哈好', false],
  ['我也想知道', false],
];
let ok = 0;
for (const [text, want] of cases) {
  const got = extractPromises(text).length > 0;
  const good = got === want;
  if (good) ok++;
  console.log(`  ${good ? '✓' : '✗'} "${text}" → ${got ? '记下承诺' : '不是承诺'}${good ? '' : ` (期望${want ? '记下' : '不记'})`}`);
}
console.log(`  通过 ${ok}/${cases.length}`);
if (ok !== cases.length) fail++;

console.log('');
console.log('二、到期时间推断');
console.log('─'.repeat(64));
const now = new Date('2026-09-19T14:00:00');
const d1 = new Date(inferDueAt('我明天告诉你', now));
check('"明天" → 次日早上 10 点', d1.getDate() === 20 && d1.getHours() === 10,
  `实际 ${d1.toISOString()}`);
const d2 = new Date(inferDueAt('我一会儿发你', now));
check('"一会儿" → 当天 2 小时后', d2.getDate() === 19 && d2.getHours() === 16,
  `实际 ${d2.toISOString()}`);
const d3 = new Date(inferDueAt('改天给你看', now));
check('"改天" → 一周后', d3.getDate() === 26, `实际 ${d3.toISOString()}`);

console.log('');
console.log('三、到期提醒（每条只提一次）');
console.log('─'.repeat(64));
const tmp = path.join(os.tmpdir(), `promises-test-${Date.now()}.json`);
const led = new PromiseLedger({ file: tmp });
const t0 = new Date('2026-09-19T14:00:00');

led.record('我明天告诉你结果', 'peerA', t0);
check('记下 1 条', led.items.length === 1, `实际 ${led.items.length}`);

const before = new Date('2026-09-19T20:00:00');
check('还没到期不该提', led.due('peerA', before).length === 0);

const after = new Date('2026-09-20T11:00:00');
const due = led.due('peerA', after);
check('到期了应该提', due.length === 1, `实际 ${due.length}`);

led.markMentioned(due[0].id, after);
check('提过之后不再提', led.due('peerA', after).length === 0, '会重复提');

console.log('');
console.log('四、过期不再提（真人也会忘掉小事）');
console.log('─'.repeat(64));
const led2 = new PromiseLedger({ file: tmp + '.2' });
led2.record('我明天告诉你结果', 'peerA', t0);
const wayLater = new Date('2026-09-25T11:00:00'); // 拖了 5 天
check('拖太久就不提了', led2.due('peerA', wayLater).length === 0);
const expired = led2.expireStale(wayLater);
check('被标记为过期', expired === 1, `实际 ${expired}`);
check('过期仍留档可查', led2.items.length === 1, '不该删除');

console.log('');
console.log('五、不会串到别人身上');
console.log('─'.repeat(64));
const led3 = new PromiseLedger({ file: tmp + '.3' });
led3.record('我明天告诉你', 'peerA', t0);
check('peerB 看不到 peerA 的承诺', led3.due('peerB', after).length === 0);

// 清理
for (const f of [tmp, tmp + '.2', tmp + '.3']) {
  try { fs.unlinkSync(f); } catch { /* noop */ }
}

console.log('');
console.log('═'.repeat(64));
console.log(`通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
