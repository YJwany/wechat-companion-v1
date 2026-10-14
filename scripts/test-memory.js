// 临时验证：多轮对话 + 记忆写入 + 隔天回忆。
// 这是"她像不像真人"最核心的验证 —— 她得真的记得你说过的事。
import { loadConfig } from '../src/config.js';
import { MemoryStore } from '../src/soul/memory.js';
import { WorldEngine } from '../src/brain/world-engine.js';
import { Soul } from '../src/soul/soul.js';

const cfg = loadConfig();
const memory = new MemoryStore({ maxEntries: 100 });
memory.entries = []; // 从干净状态开始测
const world = new WorldEngine({ cfg, memory });
const soul = new Soul({ cfg, memory, world, logger: (l, m) => console.log(`  [${l}] ${m}`) });

const PEER = 'test-peer-001';
const history = [];

async function say(text) {
  console.log('\n\x1b[36m我：\x1b[0m ' + text);
  const msg = { fromUserId: PEER, text, messageType: 1, items: [], kinds: [] };

  const r = await soul.respond(msg, history);
  if (!r) { console.log('  她: [生成失败]'); return; }

  for (const c of r.chunks) console.log('\x1b[32m她：\x1b[0m ' + c);
  console.log(`\x1b[90m     (拆 ${r.chunks.length} 条，延迟 ${r.rhythm.beforeFirst}ms)\x1b[0m`);

  history.push({ role: 'user', content: text });
  history.push({ role: 'assistant', content: r.raw });
  await soul.extractMemories(msg, r.raw);
}

console.log('════════ 第一轮：她第一次认识他 ════════');
await say('你好啊，我叫陈默，住在南京');
await say('我养了一只叫豆豆的柯基，特别闹');
await say('我不太能吃辣，上次吃火锅胃疼了一晚上');

console.log('\n\n════════ 记忆里现在有什么 ════════');
for (const e of memory.recent(20)) {
  console.log(`  [${e.bucket}] ${e.text}`);
}
console.log(`\n统计: ${JSON.stringify(memory.stats())}`);

console.log('\n\n════════ 第二轮：模拟"第二天"，看她记不记得 ════════');
// 清空对话历史，只看记忆能不能把信息带回来 —— 这才是真本事
history.length = 0;
await say('还记得我叫什么吗');
await say('我那只狗叫什么来着');
await say('晚上想吃火锅，你觉得呢');

console.log('\n\n════════ 检索验证 ════════');
console.log('查询"火锅"命中的记忆:');
for (const m of memory.recall('火锅', { topK: 3, who: PEER })) {
  console.log(`  · ${m.text}  (bucket=${m.bucket})`);
}
