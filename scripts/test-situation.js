// 验证"此刻状态"修复：她回答"在干嘛"时应该只说当下，不倒全天流水。
import { loadConfig } from '../src/config.js';
import { WorldEngine } from '../src/brain/world-engine.js';
import { MemoryStore } from '../src/soul/memory.js';
import { Soul } from '../src/soul/soul.js';
import { currentSituation } from '../src/soul/persona.js';

const cfg = loadConfig();
const mem = new MemoryStore();
const w = new WorldEngine({ cfg, memory: mem });
const soul = new Soul({ cfg, memory: mem, world: w, logger: () => {} });

const today = soul.todayFor(new Date());
const flow = today.flow || '(无流水)';

console.log('全天流水:', flow);
console.log('');
console.log('不同时刻，她认为"自己此刻在做什么"：');
console.log('─'.repeat(60));
for (const h of [7, 9, 11, 13, 15, 17, 19, 21, 23]) {
  const d = new Date();
  d.setHours(h, 30, 0, 0);
  const s = currentSituation(d, today);
  const flag = s.activity === flow ? '  ⚠️ 倒出全天' : '';
  console.log(`  ${String(h).padStart(2)}:30  →  ${s.activity}${flag}`);
}
