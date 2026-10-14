// 复读止血的**接线**验证：不依赖模型碰巧重复，直接查状态是否真的在流转。
//
// 背景：A/B 实测里"开"和"关"都没检出重复（模型这轮表现好），
// 所以那个对比证不了护栏有效。这里改查机制本身：
//   1. 她说过的话有没有被记下来
//   2. 重启后还记不记得（落盘）
//   3. 拿记下来的话反过来喂判重器，判不判得出来
import { Companion } from '../src/companion.js';
import { checkRepeat, RECENT_KEEP } from '../src/soul/repeat.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name} ${extra}`); fail++; }
};

const PEER = 'peer-repeat-wire';
const c = new Companion();
c.soul.relations.delete(PEER);
delete c.state.histories?.[PEER];
delete c.state.summaries?.[PEER];
c.histories.delete(PEER);

console.log('一、她说过的话会被记下来');
console.log('─'.repeat(64));

const turns = ['今天过得怎么样', '忙吗', '在干嘛', '累不累'];
for (const t of turns) {
  const msg = { fromUserId: PEER, text: t, items: [], contextToken: '' };
  const h = c.getHistory(PEER);
  const r = await c.soul.respond(msg, h);
  if (r) {
    h.push({ role: 'user', content: t });
    h.push({ role: 'assistant', content: r.raw });
    c.setHistory(PEER, h);
  }
}

const rel = c.soul.relationFor(PEER);
console.log('  记下来的话:');
for (const r of rel.recentReplies) console.log(`    · ${r}`);
check('recentReplies 有内容', rel.recentReplies.length > 0, `实际 ${rel.recentReplies.length} 条`);
check(`最多留 ${RECENT_KEEP} 条`, rel.recentReplies.length <= RECENT_KEEP);

console.log('');
console.log('二、重启后她还记得（落盘 → 重新加载）');
console.log('─'.repeat(64));
c.saveState();
const before = [...rel.recentReplies];

const c2 = new Companion();  // 模拟进程重启
const rel2 = c2.soul.relationFor(PEER);
console.log('  重启后读到:');
for (const r of rel2.recentReplies) console.log(`    · ${r}`);
check('recentReplies 落盘并恢复', rel2.recentReplies.length === before.length,
  `重启前 ${before.length} 条，重启后 ${rel2.recentReplies.length} 条`);
check('内容一致', JSON.stringify(rel2.recentReplies) === JSON.stringify(before));

console.log('');
console.log('三、拿记下来的话反过来喂判重器');
console.log('─'.repeat(64));
if (before.length) {
  const orig = before[0];
  const r1 = checkRepeat(orig, before);
  check('原话说第二遍 → 判重', r1.repeat, `实际 ${r1.repeat}`);

  const reworded = `今天${orig}`;
  const r2 = checkRepeat(reworded, before);
  check('加个"今天"再说 → 也判重', r2.repeat, `实际 ${r2.repeat}`);

  const fresh = '我下午去了趟城南的书市，淘到一本绝版的诗集';
  const r3 = checkRepeat(fresh, before);
  check('说件新的事 → 放行', !r3.repeat, `被判重: ${r3.reason}`);
}

console.log('');
console.log('四、判重记录跟着关系状态一起走');
console.log('─'.repeat(64));
const serialized = c.soul.serialize();
check('serialize 里带上了 recentReplies',
  Array.isArray(serialized.relations?.[PEER]?.recentReplies),
  JSON.stringify(Object.keys(serialized.relations?.[PEER] ?? {})));
check('是普通数组（能被 JSON 序列化）',
  Array.isArray(JSON.parse(JSON.stringify(serialized)).relations[PEER].recentReplies));

console.log('');
console.log('═'.repeat(64));
console.log(`通过 ${pass} / ${pass + fail}`);

// 清理
c.soul.relations.delete(PEER);
delete c.state.histories?.[PEER];
c.histories.delete(PEER);
c.saveState();
process.exit(fail ? 1 : 0);
