// 临时验证：跑一次世界引擎，看她能不能写出像样的"明天"。
import { loadConfig } from '../src/config.js';
import { MemoryStore } from '../src/soul/memory.js';
import { WorldEngine } from '../src/brain/world-engine.js';

const cfg = loadConfig();
const memory = new MemoryStore({ maxEntries: 100 });
const world = new WorldEngine({ cfg, memory });

console.log('世界引擎使用槽位:', JSON.stringify(world.resolveSlot(), (k, v) => k === 'apiKey' ? '***' : v));
console.log('开始生成明天的剧本…\n');

const t0 = Date.now();
const r = await world.generateForTomorrow(new Date());

if (!r.ok) {
  console.log('✗ 失败:', r.reason);
  process.exit(1);
}

const s = r.script;
console.log(`✓ 完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
console.log('生效日期:', s.forDate);
console.log('作息    :', s.wakeAt, '起 /', s.sleepAt, '睡');
console.log('心情    :', s.mood);
console.log('天气    :', s.weather);
console.log('一直想着:', s.focus);
console.log('生活流水:', s.flow);
console.log('心里念头:', s.thoughts);
console.log('小秘密  :', s.secret);
console.log('社交圈  :', s.npcs.map((n) => `${n.name}(${n.relation})`).join('、'));
console.log('\n─── 她的日记 ───\n');
console.log(s.diary);
console.log('\n─── 降级标记 ───');
console.log(s.degraded ? '⚠️  复用了对话模型（建议配独立模型）' : '✓ 使用了独立模型槽位');
