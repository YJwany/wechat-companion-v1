// 真实模型端到端：给一段大致的人物模板，看能不能生成可用人设。
import { loadConfig } from '../src/config.js';
import { forgePersona, detectOverrides } from '../src/soul/forge.js';
import { MBTI_LIST } from '../src/soul/mbti.js';

const cfg = loadConfig();

const TEMPLATES = [
  {
    label: '只有一句话',
    text: '我想让她是个温柔的南方姑娘',
  },
  {
    label: '带明确指定（名字/城市/年龄）',
    text: '她叫阿梨，26岁，在成都做插画师。话不多，有点慢热，喜欢猫和下雨天。',
  },
  {
    label: '带性格倾向',
    text: '一个有点毒舌但心软的女生，在北京做程序员，喜欢熬夜打游戏，嘴硬。',
  },
];

const current = cfg.persona;

for (const t of TEMPLATES) {
  console.log('═'.repeat(66));
  console.log(`模板：${t.label}`);
  console.log(`输入：${t.text}`);
  console.log('─'.repeat(66));

  const t0 = Date.now();
  const r = await forgePersona({ cfg, template: t.text, current });
  const ms = Date.now() - t0;

  if (!r.ok) {
    console.log(`✗ 失败（${ms}ms）: ${r.reason}`);
    continue;
  }

  const p = r.persona;
  console.log(`✓ 生成成功（${ms}ms）\n`);
  console.log(`  名字      ${p.name}`);
  console.log(`  性别年龄  ${p.gender === 'female' ? '女' : '男'} / ${p.age} 岁`);
  console.log(`  城市      ${p.city}`);
  console.log(`  职业      ${p.job}`);
  console.log(`  MBTI      ${p.mbti}`);
  console.log(`  兴趣      ${(p.interests ?? []).join('、')}`);
  console.log(`  emoji     ${p.emojiRate}%`);
  console.log(`  说话风格  ${p.speechStyle}`);
  console.log(`  背景      ${p.background}`);

  // ── 自动检查 ──
  const problems = [];
  if (!p.name || p.name.length > 12) problems.push('名字不合法');
  if (!Number.isInteger(p.age) || p.age < 16 || p.age > 60) problems.push(`年龄越界: ${p.age}`);
  if (!MBTI_LIST.includes(p.mbti)) problems.push(`MBTI 非法: ${p.mbti}`);
  if (!Array.isArray(p.interests) || p.interests.length < 3) problems.push('兴趣太少');
  if (!p.speechStyle || p.speechStyle.length < 8) problems.push('说话风格太短，没法照着演');
  if (!p.job || p.job.length < 4) problems.push('职业太短');
  if (r.warnings?.length) problems.push(`校验警告: ${r.warnings.join('；')}`);

  // 用户明确说过的有没有被改
  const overrides = detectOverrides(t.text, p, current);
  if (overrides.length) problems.push(`改动: ${overrides.join('；')}`);

  console.log('');
  if (problems.length) {
    console.log(`  ⚠ ${problems.join('\n  ⚠ ')}`);
  } else {
    console.log('  ✓ 全部字段合法，且没有改动用户明确指定的信息');
  }
  console.log('');
}

console.log('═'.repeat(66));
console.log('说明：模型每次输出不同，以上是一次真实采样的结果。');
