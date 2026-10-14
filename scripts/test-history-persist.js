// 用真实的 Companion 方法验证历史持久化与摘要保留（而不是手写 state）。
import { Companion } from '../src/companion.js';
import { STATE_FILE, readJsonSafe, writeJsonAtomic } from '../src/config.js';

const PEER = '__test_peer__';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name} ${extra}`); fail++; }
};

console.log('对话历史持久化（走真实方法）');
console.log('═'.repeat(64));

// 备份原 state
const backup = readJsonSafe(STATE_FILE, {});

// 第一个实例：写入 30 轮对话
const c1 = new Companion();
let h = c1.getHistory(PEER);
check('初始为空', h.length === 0);

for (let i = 0; i < 30; i++) {
  h = c1.getHistory(PEER);
  h.push({ role: 'user', content: `用户消息${i}` });
  h.push({ role: 'assistant', content: `她的回复${i}` });
  c1.setHistory(PEER, h);
}
console.log(`  写入 60 条后治理为 ${c1.getHistory(PEER).length} 条`);

// 模拟进程重启：全新实例，从磁盘读
const c2 = new Companion();
const h2 = c2.getHistory(PEER);

console.log('');
console.log('重启后：');
check('历史没丢', h2.length > 0, `实际 ${h2.length} 条`);
check('历史被治理到合理长度', h2.length <= 40, `实际 ${h2.length}`);
check('保留了最新的一条', h2[h2.length - 1].content === '她的回复29', `实际 "${h2[h2.length - 1]?.content}"`);
check('摘要也保留了', !!h2.summary, '摘要丢失（JSON 不序列化数组属性）');
if (h2.summary) {
  check('摘要包含更早的内容', h2.summary.includes('用户消息0') || h2.summary.includes('用户消息5'),
    `摘要开头: ${h2.summary.slice(0, 40)}`);
}

// 恢复
writeJsonAtomic(STATE_FILE, backup);
console.log('');
console.log('═'.repeat(64));
console.log(`通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
