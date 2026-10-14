// 检查：她对"情绪明显"的消息回应得对得上吗？
import { Companion } from '../src/companion.js';

const c = new Companion();
const PEER = 'peer-tone-test';
delete c.state.histories?.[PEER];
c.histories.delete(PEER);

// 每条都单独测（清空历史），看她的第一反应对不对
const scenes = [
  { text: '哈哈哈哈哈笑死我了', want: '一起笑/觉得好玩', bad: /累|辛苦/ },
  { text: '我今天被老板骂了', want: '安慰', bad: /^哈哈|恭喜/ },
  { text: '我升职了！', want: '替高兴', bad: /累|辛苦|可惜/ },
  { text: '我有点难过', want: '关心', bad: /^哈哈|恭喜|加油/ },
];

console.log('语气匹配检查（每条都清空历史单独测）');
console.log('═'.repeat(66));

let good = 0;
for (const s of scenes) {
  delete c.state.histories?.[PEER];
  c.histories.delete(PEER);
  const msg = { fromUserId: PEER, text: s.text, items: [], contextToken: '' };
  const r = await c.soul.respond(msg, []);
  const reply = r?.chunks.join(' ') ?? '';
  const wrong = s.bad.test(reply);
  if (!wrong) good++;
  console.log(`我: ${s.text}`);
  console.log(`她: ${reply}`);
  console.log(`   期望: ${s.want}  → ${wrong ? '✗ 明显不对味' : '✓ 没跑偏'}`);
  console.log('');
}

console.log('═'.repeat(66));
console.log(`对味 ${good}/${scenes.length}`);
delete c.state.histories?.[PEER];
c.saveState();
