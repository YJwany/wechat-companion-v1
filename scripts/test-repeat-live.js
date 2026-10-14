// 验证复读止血真的生效：对比"开"和"关"两种情况下她重复的程度。
import { Companion } from '../src/companion.js';
import { checkRepeat } from '../src/soul/repeat.js';

const c = new Companion();
c.cfg.soul ??= {};
c.cfg.behavior = c.cfg.behavior ?? {};

const SAME = '今天过得怎么样';
const N = 6;

async function run(label, enableGuard) {
  const PEER = `peer-rep-${label}`;
  delete c.state.histories?.[PEER];
  delete c.state.summaries?.[PEER];
  c.histories.delete(PEER);
  c.soul.relations.delete(PEER);

  // 用 monkey patch 关掉/打开判重，其余流程完全一致
  const origRelationFor = c.soul.relationFor.bind(c.soul);
  if (!enableGuard) {
    c.soul.relationFor = (peerId) => {
      const rel = origRelationFor(peerId);
      // 每次清空，等于"没有复读止血"
      rel.recentReplies = [];
      return rel;
    };
  } else {
    c.soul.relationFor = origRelationFor;
  }

  const replies = [];
  for (let i = 0; i < N; i++) {
    const msg = { fromUserId: PEER, text: SAME, items: [], contextToken: '' };
    const history = c.getHistory(PEER);
    const r = await c.soul.respond(msg, history);
    const reply = r?.chunks.join(' ') ?? '(没说话)';
    replies.push(reply);
    if (r) {
      history.push({ role: 'user', content: SAME });
      history.push({ role: 'assistant', content: r.raw });
      c.setHistory(PEER, history);
    }
  }
  c.soul.relationFor = origRelationFor;

  // 统计重复
  let high = 0;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      if (replies[i] === '(没说话)' || replies[j] === '(没说话)') continue;
      if (checkRepeat(replies[i], [replies[j]]).repeat) high++;
    }
  }
  const silent = replies.filter((r) => r === '(没说话)').length;

  console.log(`【${label}】`);
  replies.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
  console.log(`  很像的配对: ${high} / 15    没说发话: ${silent} 次`);
  console.log('');
  return { high, silent };
}

console.log('复读止血：开 / 关 对比（同一句话问 6 次）');
console.log('═'.repeat(70));
console.log('');
const off = await run('没开复读止血', false);
const on = await run('开了复读止血', true);

console.log('═'.repeat(70));
console.log('对比');
console.log(`  没开：很像的配对 ${off.high} 组，她沉默 ${off.silent} 次`);
console.log(`  开了：很像的配对 ${on.high} 组，她沉默 ${on.silent} 次`);
console.log('');
if (on.high < off.high) {
  console.log('✓ 复读明显减少');
} else if (on.high === off.high && on.high === 0) {
  console.log('· 两边都没检出复读（这轮模型表现好，不能证明护栏有效）');
} else {
  console.log('✗ 没改善');
}

// ── 清理：把这次造的测试 peer 从真实 state 里摘掉 ──
// 不清理的话，跑一次就在真实数据里留下两个假关系。
for (const PEER of ['peer-rep-没开复读止血', 'peer-rep-开了复读止血']) {
  c.histories.delete(PEER);
  c.soul.relations.delete(PEER);
  delete c.state.histories?.[PEER];
  delete c.state.summaries?.[PEER];
}
c.saveState();
console.log('（已清理测试 peer）');
