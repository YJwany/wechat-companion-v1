// 端到端试聊：走真实的 Soul.respond 链路，检查新功能是否破坏原有行为。
import { Companion } from '../src/companion.js';

const c = new Companion();
const PEER = 'peer-e2e-test';

// 清掉这个 peer 的历史，保证测试干净
delete c.state.histories?.[PEER];
delete c.state.summaries?.[PEER];
c.histories.delete(PEER);

const script = [
  '在干嘛呢',
  '我养了一只柯基叫豆豆',
  '你还记得我叫什么吗',
  '我那只狗叫什么来着',
  '晚上想吃火锅',
];

console.log('端到端试聊（真实模型 + 完整链路）');
console.log('═'.repeat(66));

for (const text of script) {
  const msg = { fromUserId: PEER, text, items: [], contextToken: '' };
  const history = c.getHistory(PEER);
  const result = await c.soul.respond(msg, history);

  if (!result) {
    console.log(`我: ${text}`);
    console.log('她: (没有回复)');
    continue;
  }

  console.log(`我: ${text}`);
  console.log(`她: ${result.chunks.join(' / ')}`);

  // 走真实的写历史/记承诺路径
  history.push({ role: 'user', content: text });
  history.push({ role: 'assistant', content: result.raw });
  c.setHistory(PEER, history);
  c.promises.record(result.raw, PEER);
  console.log('');
}

console.log('═'.repeat(66));
console.log('历史条数:', c.getHistory(PEER).length, '（应 <= 40）');
console.log('承诺账本:', JSON.stringify(c.promises.stats()));
const h = c.getHistory(PEER);
console.log('是否有断片风险:', h.length > 0 ? '否 ✓' : '是 ✗');

// 清理
delete c.state.histories[PEER];
delete c.state.summaries?.[PEER];
c.saveState();
