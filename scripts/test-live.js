// 线上实测：模拟微信里的多轮对话，观察她的真实表现。
import { loadConfig } from '../src/config.js';
import { MemoryStore } from '../src/soul/memory.js';
import { WorldEngine } from '../src/brain/world-engine.js';
import { Soul } from '../src/soul/soul.js';

const cfg = loadConfig();
const memory = new MemoryStore({ maxEntries: 100 });
const world = new WorldEngine({ cfg, memory });
const soul = new Soul({ cfg, memory, world, logger: () => {} });

const PEER = 'live-test';
const history = [];

async function say(text) {
  const t0 = Date.now();
  const msg = { fromUserId: PEER, text, messageType: 1, items: [], kinds: [] };
  const r = await soul.respond(msg, history);
  console.log(`\n\x1b[36m我：\x1b[0m ${text}`);
  if (!r) { console.log('  \x1b[31m[生成失败]\x1b[0m'); return; }
  console.log(`\x1b[32m她：\x1b[0m ${r.chunks.join('\n     ')}`);
  console.log(`\x1b[90m     ${r.chunks.length} 条 / 延迟 ${r.rhythm.beforeFirst}ms / 生成 ${Date.now() - t0}ms\x1b[0m`);
  history.push({ role: 'user', content: text });
  history.push({ role: 'assistant', content: r.raw });
  await soul.extractMemories(msg, r.raw);
}

const today = soul.todayFor();
console.log('════════ 她此刻的状态 ════════');
console.log(`  作息: ${today.wakeAt} 起 / ${today.sleepAt} 睡`);
console.log(`  心情: ${today.mood}`);
console.log(`  来源: ${today.fromWorld ? '世界引擎剧本' : '随机兜底'}`);

console.log('\n════════ 模拟真实微信对话 ════════');
await say('你好');
await say('今天书店忙吗');
await say('我最近在学做饭，但是总是糊锅');
await say('你觉得我适合养猫吗');
await say('有点困了，我先睡了');

console.log('\n\n════════ 她记住了什么 ════════');
for (const e of memory.recent(20)) console.log(`  [${e.bucket}] ${e.text}`);
