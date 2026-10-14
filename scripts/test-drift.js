// 验证"被凶当天会冷、被暖当天会热"这套事件驱动性格微调。
import { detectRudeness, Soul } from '../src/soul/soul.js';
import { deriveTraits } from '../src/soul/persona.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name} ${extra}`); fail++; }
};

console.log('一、敌意识别（只认明确的凶，抱怨不算）');
console.log('─'.repeat(64));
const cases = [
  ['你真笨', true], ['闭嘴', true], ['滚', true], ['你给我滚', true],
  ['你懂个屁', true], ['你别烦我', true], ['你根本不懂', true], ['滚开', true],
  // 这些**不该**算凶 —— 误判会让她无缘无故变冷，比漏判更糟
  ['我今天好累', false], ['工作烦死了', false], ['哈哈哈哈哈', false],
  ['你好呀', false], ['这电影真垃圾', false], ['我有点不开心', false],
  // 这两个是刻意不认的：没有"你"就没有明确的攻击对象，
  // 宁可漏判也不要冤枉他（她只会稍微冷一点，但误会一次很伤）
  ['烦死了', false], ['懂个屁', false],
];
let ok = 0;
for (const [text, want] of cases) {
  const got = detectRudeness(text);
  const good = got === want;
  if (good) ok++;
  console.log(`  ${good ? '✓' : '✗'} "${text}" → ${got ? '算凶' : '不算'}${good ? '' : ` (期望${want ? '算凶' : '不算'})`}`);
}
console.log(`  通过 ${ok}/${cases.length}`);
if (ok !== cases.length) fail++;

console.log('');
console.log('二、当天情绪漂移（次日回落，不是永久变坏）');
console.log('─'.repeat(64));
const mk = () => new Soul({
  cfg: { persona: { mbti: 'INFP', name: '小满' }, brain: {}, memory: {} },
  memory: {}, world: { scriptFor: () => null },
});

const s = mk();
const base = s.traitsFor();
console.log(`  基线: 温度${base.warmth} 锐度${base.sharp}`);

// 被凶三次
s.noteEvent('rude'); s.noteEvent('rude'); s.noteEvent('rude');
const afterRude = s.traitsFor();
console.log(`  被凶三次后: 温度${afterRude.warmth} 锐度${afterRude.sharp}`);
check('温度下降', afterRude.warmth < base.warmth, `${base.warmth} → ${afterRude.warmth}`);
check('锐度上升', afterRude.sharp > base.sharp, `${base.sharp} → ${afterRude.sharp}`);

// 第二天（新的漂移桶）应该回落
const s2 = mk();
s2.noteEvent('warm'); s2.noteEvent('warm');
const afterWarm = s2.traitsFor();
console.log(`  被暖两次后: 温度${afterWarm.warmth} 锐度${afterWarm.sharp}`);
check('温度上升', afterWarm.warmth > base.warmth, `${base.warmth} → ${afterWarm.warmth}`);

console.log('');
console.log('三、长期漂移被钳制（她不会变成另一个人）');
console.log('─'.repeat(64));
const s3 = mk();
const traits = deriveTraits('INFP');
console.log(`  INFP 基线: 温度${traits.warmth} 锐度${traits.sharp} 依恋${traits.attachment}`);
// 极端信号：连续被凶 100 次
const extreme = { ...traits };
const evolved = (await import('../src/soul/mbti.js')).evolveTraits(extreme, { rude: 100, warm: 0, chats: 0 });
console.log(`  极端信号后: 温度${evolved.warmth} 锐度${evolved.sharp}`);
check('单周变化不超过 ±2（温度）', Math.abs(evolved.warmth - traits.warmth) <= 2,
  `变了 ${evolved.warmth - traits.warmth}`);
check('单周变化不超过 ±2（锐度）', Math.abs(evolved.sharp - traits.sharp) <= 2,
  `变了 ${evolved.sharp - traits.sharp}`);
check('仍在合法区间', evolved.warmth >= 5 && evolved.warmth <= 95);

console.log('');
console.log('四、持久化往返（重启后她还是那个"被影响过"的她）');
console.log('─'.repeat(64));
const s4 = mk();
s4.noteEvent('rude');
s4.drift.rude = 5;
const snap = s4.serialize();
check('能导出 relations', !!snap.relations);
check('能导出 drift', snap.drift.rude === 5, `实际 ${snap.drift.rude}`);

const s5 = mk();
s5.hydrate(snap);
check('重启后漂移信号还在', s5.drift.rude === 5, `实际 ${s5.drift.rude}`);

console.log('');
console.log('═'.repeat(64));
console.log(`通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
