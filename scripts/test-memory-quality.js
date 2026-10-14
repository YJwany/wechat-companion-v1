// 批量验证记忆提炼质量（覆盖各类事实与反例）。
import { loadConfig } from '../src/config.js';
import { MemoryStore } from '../src/soul/memory.js';
import { WorldEngine } from '../src/brain/world-engine.js';
import { Soul } from '../src/soul/soul.js';

const cfg = loadConfig();
const memory = new MemoryStore({ maxEntries: 100 });
memory.entries = [];
const world = new WorldEngine({ cfg, memory });
const soul = new Soul({ cfg, memory, world, logger: () => {} });

// [输入, 期望至少提取到]
const CASES = [
  ['我不太能吃辣，上次吃火锅胃疼了一晚上', 1],
  ['我养了一只叫豆豆的柯基，特别闹', 1],
  ['你好啊，我叫陈默，住在南京', 2],
  ['我最近在做一个建筑设计的项目，天天加班', 1],
  ['我老家在东北，冬天特别冷', 1],
  ['哈哈哈哈', 0],
  ['在吗', 0],
  ['今天天气真好啊', 0],
  ['我妹妹下个月结婚，我得回去一趟', 1],
  ['我对花生过敏，一点都不能碰', 1],
];

let pass = 0, fail = 0;
for (const [text, minFacts] of CASES) {
  const before = memory.entries.length;
  await soul.extractWithModel({ fromUserId: 'p1', text }, 'p1');
  const got = memory.entries.slice(before).map((e) => e.text);
  const ok = got.length >= minFacts;
  if (ok) pass++; else fail++;
  console.log(`${ok ? '✓' : '✗'} 「${text}」`);
  console.log(`    期望 ≥${minFacts} 条，实得 ${got.length} 条: ${got.join(' / ') || '(无)'}`);
}
console.log(`\n通过 ${pass} / ${pass + fail}`);
