// 真实验证重逢：把"上次说话时间"拨到过去，看她回来时说什么。
import { Companion } from '../src/companion.js';
import { reunionHint, longingLevel } from '../src/soul/longing.js';

const c = new Companion();
const PEER = 'peer-reunion-test';

async function scenario(label, hoursAgo, text) {
  c.soul.relations.delete(PEER);
  delete c.state.histories?.[PEER];
  delete c.state.summaries?.[PEER];
  delete c.state.reunions?.[PEER];
  c.histories.delete(PEER);

  // 先有一段正常聊天打底
  {
    const h = c.getHistory(PEER);
    const r = await c.soul.respond({ fromUserId: PEER, text: '你好', items: [], contextToken: '' }, h);
    if (r) {
      h.push({ role: 'user', content: '你好' });
      h.push({ role: 'assistant', content: r.raw });
      c.setHistory(PEER, h);
    }
  }

  // 把上次说话时间拨到 hoursAgo 小时前
  c.state.lastUserAt = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  const silent = c.silentHours();

  // 走真实的 handleMessage 前半段逻辑
  const reunion = c.reunion.check(PEER, silent);
  const msg = { fromUserId: PEER, text, items: [], contextToken: '' };
  if (reunion.settle) {
    msg.hint = reunionHint(reunion.tone, silent);
    c.reunion.settle(PEER);
  }

  const h2 = c.getHistory(PEER);
  const r = await c.soul.respond(msg, h2);

  console.log(`【${label}】距上次说话 ${hoursAgo}h（想念强度 ${longingLevel(silent).toFixed(2)}）`);
  console.log(`  触发重逢提示: ${reunion.settle ? '是' : '否'}  语气档: ${reunion.tone}`);
  console.log(`  我: ${text}`);
  console.log(`  她: ${r?.chunks.join(' / ') ?? '(没说话)'}`);

  // 紧接着再说一句，检查会不会**又**提
  if (reunion.settle) {
    const h3 = c.getHistory(PEER);
    if (r) { h3.push({ role: 'user', content: text }); h3.push({ role: 'assistant', content: r.raw }); }
    const again = c.reunion.check(PEER, c.silentHours());
    console.log(`  紧接着第二句还会不会提: ${again.settle ? '✗ 会（不该）' : '✓ 不会'}`);
  }
  console.log('');
  return r;
}

console.log('重逢：失联不同时长后回来，她的反应');
console.log('═'.repeat(70));
console.log('');

await scenario('刚聊完（8h）', 8, '在吗');
await scenario('隔了一天（20h）', 20, '在吗');
await scenario('隔了两天（48h）', 48, '我回来了');
await scenario('隔了一周（170h）', 170, '最近有点忙');

// 清理
c.soul.relations.delete(PEER);
delete c.state.histories?.[PEER];
delete c.state.reunions?.[PEER];
c.histories.delete(PEER);
c.saveState();
