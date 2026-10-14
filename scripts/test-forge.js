// 验证人设贴合：解析要稳、校验要能修、不许改用户明说的东西。
import { parseForgeReply, normalizePersona, buildForgePrompt, detectOverrides, extractExplicit, forgePersona, FORGE_FIELDS } from '../src/soul/forge.js';
import { MBTI_LIST } from '../src/soul/mbti.js';

let pass = 0, fail = 0;
const check = (n, c, extra = '') => {
  if (c) { console.log(`  ✓ ${n}`); pass++; }
  else { console.log(`  ✗ ${n} ${extra}`); fail++; }
};

const BASE = {
  name: '小满', gender: 'female', age: 24, city: '杭州',
  job: '在一家独立书店做店员', background: '喜欢在旧书里夹东西。',
  mbti: 'INFP', speechStyle: '语速不快，喜欢用短句。',
  interests: ['旧书', '猫'], emojiRate: 20,
};

console.log('一、从模型回复里挖 JSON（小模型最容易在这里翻车）');
console.log('─'.repeat(64));
{
  const good = '{"name":"小雨","age":23}';
  check('纯 JSON', parseForgeReply(good)?.name === '小雨');

  check('```json 代码块', parseForgeReply('```json\n{"name":"小雨"}\n```')?.name === '小雨');
  check('``` 无语言标记', parseForgeReply('```\n{"name":"小雨"}\n```')?.name === '小雨');

  check('★ 前后带啰嗦的话',
    parseForgeReply('好的，这是为你设计的人设：\n{"name":"小雨","age":23}\n希望你喜欢！')?.name === '小雨');

  check('★ JSON 后面还跟了解释',
    parseForgeReply('{"name":"小雨"}\n\n我给她设计了温柔的性格。')?.name === '小雨');

  check('空字符串返回 null', parseForgeReply('') === null);
  check('纯垃圾返回 null', parseForgeReply('我做不到') === null);
  check('null 返回 null', parseForgeReply(null) === null);
  check('★ 不会因为抠不出 JSON 就抛错', (() => {
    try { parseForgeReply('{ 这是个不合法的 json }'); return true; } catch { return false; }
  })());
}

console.log('');
console.log('二、校验：能修就修，不整份丢掉');
console.log('─'.repeat(64));
{
  // 年龄越界
  let r = normalizePersona({ ...BASE, age: 900 }, BASE);
  check('年龄 900 被夹到 60', r.persona.age === 60, String(r.persona.age));
  check('说明了被夹', r.warnings.some((w) => /年龄/.test(w)));

  r = normalizePersona({ ...BASE, age: 3 }, BASE);
  check('年龄 3 被抬到 16', r.persona.age === 16, String(r.persona.age));

  r = normalizePersona({ ...BASE, age: '二十三' }, BASE);
  check('年龄不是数字 → 保留原值', r.persona.age === 24, String(r.persona.age));

  // emoji 三种写法
  check('emojiRate "20%" → 20', normalizePersona({ ...BASE, emojiRate: '20%' }, BASE).persona.emojiRate === 20);
  check('★ emojiRate 0.2 → 20（不是 0）', normalizePersona({ ...BASE, emojiRate: 0.2 }, BASE).persona.emojiRate === 20,
    String(normalizePersona({ ...BASE, emojiRate: 0.2 }, BASE).persona.emojiRate));
  check('emojiRate 999 被夹到 60', normalizePersona({ ...BASE, emojiRate: 999 }, BASE).persona.emojiRate === 60);

  // MBTI
  check('合法 MBTI 保留', normalizePersona({ ...BASE, mbti: 'ENFP' }, BASE).persona.mbti === 'ENFP');
  check('小写 mbti 被归一化', normalizePersona({ ...BASE, mbti: 'enfp' }, BASE).persona.mbti === 'ENFP');
  r = normalizePersona({ ...BASE, mbti: 'XXXX' }, BASE);
  check('非法 MBTI → 回退到原值', r.persona.mbti === 'INFP');
  check('非法 MBTI 有警告', r.warnings.some((w) => /MBTI/.test(w)));
  check('★ 所有 MBTI 都合法', MBTI_LIST.every((m) => normalizePersona({ ...BASE, mbti: m }, BASE).persona.mbti === m));

  // 兴趣
  r = normalizePersona({ ...BASE, interests: '旧书、手冲、猫' }, BASE);
  check('兴趣是字符串也能拆', r.persona.interests.length === 3, JSON.stringify(r.persona.interests));
  r = normalizePersona({ ...BASE, interests: ['猫', '猫', '猫', '书'] }, BASE);
  check('兴趣去重', r.persona.interests.length === 2, JSON.stringify(r.persona.interests));
  r = normalizePersona({ ...BASE, interests: Array(20).fill(0).map((_, i) => `爱好${i}`) }, BASE);
  check('兴趣太多被截到 8', r.persona.interests.length === 8, String(r.persona.interests.length));
  r = normalizePersona({ ...BASE, interests: '不是数组也不是字符串'.split('').slice(0, 1) }, BASE);
  check('兴趣类型怪也不会崩', Array.isArray(r.persona.interests));

  // 文本字段
  r = normalizePersona({ ...BASE, job: 'a'.repeat(200) }, BASE);
  check('job 太长被截断', r.persona.job.length === 40, String(r.persona.job.length));
  r = normalizePersona({ ...BASE, background: '' }, BASE);
  check('★ 空字段保留原值（不会把她的人设抹掉）', r.persona.background === BASE.background);

  // 性别
  check('"女" → female', normalizePersona({ ...BASE, gender: '女' }, BASE).persona.gender === 'female');
  check('"男" → male', normalizePersona({ ...BASE, gender: '男' }, BASE).persona.gender === 'male');
  check('乱写 → female', normalizePersona({ ...BASE, gender: '???' }, BASE).persona.gender === 'female');

  // 完全空对象
  r = normalizePersona({}, BASE);
  check('★ 全空也不崩，且保住原人设', r.persona.name === '小满' && r.persona.age === 24);
  r = normalizePersona(null, BASE);
  check('传 null 也不崩', r.persona.name === '小满');
}

console.log('');
console.log('三、提示词要把约束写清楚');
console.log('─'.repeat(64));
{
  const p = buildForgePrompt('她是个在成都的插画师', BASE);
  check('带上用户描述', p.includes('她是个在成都的插画师'));
  check('要求输出 JSON', /JSON/.test(p));
  check('★ 明确要求不许改用户说过的', /一个字都不要改/.test(p));
  check('★ 明确要求不许编造人生事件', /不要编造具体的人生事件/.test(p));
  check('要求字段自洽', /自洽/.test(p));
  check('列出了所有 MBTI 选项', MBTI_LIST.every((m) => p.includes(m)));
  check('给了 JSON 结构样例', p.includes('"emojiRate"'));

  const empty = buildForgePrompt('', BASE);
  check('空描述也能用（有兜底话术）', empty.includes('自己设计'));
}

console.log('');
console.log('四、硬检查：用户明说的有没有被改掉');
console.log('─'.repeat(64));
{
  let n = detectOverrides('她叫小满，在杭州', { name: '小雨', city: '杭州' }, BASE);
  check('★ 名字被改了要报出来', n.some((x) => /小满/.test(x)), JSON.stringify(n));

  n = detectOverrides('她叫小满', { name: '小满' }, BASE);
  check('名字没改就不报', n.length === 0, JSON.stringify(n));

  // ★ 关键场景：模板里指定了**新**城市，生成结果没跟上
  n = detectOverrides('她想住在成都', { city: '重庆' }, BASE);
  check('★ 模板指定了新城市、生成没跟上 → 要报',
    n.some((x) => /成都/.test(x) && /重庆/.test(x)), JSON.stringify(n));

  n = detectOverrides('她想住在成都', { city: '成都' }, BASE);
  check('跟上了就不报', n.length === 0, JSON.stringify(n));

  n = detectOverrides('在成都工作', { city: '成都' }, BASE);
  check('"在X工作"也能抠出城市', n.length === 0, JSON.stringify(n));

  n = detectOverrides('她是成都人', { city: '重庆' }, BASE);
  check('"X人"也能抠出城市', n.some((x) => /成都/.test(x)), JSON.stringify(n));

  n = detectOverrides('她 26 岁', { age: 22 }, BASE);
  check('年龄被改了要报出来', n.some((x) => /26/.test(x)), JSON.stringify(n));

  n = detectOverrides('她 26 岁', { age: 26 }, BASE);
  check('年龄一致就不报', n.length === 0, JSON.stringify(n));

  n = detectOverrides('她是个男孩', { gender: 'female' }, BASE);
  check('性别被改了要报出来', n.some((x) => /性别/.test(x)), JSON.stringify(n));

  // 回归：'female'.includes('male') === true，曾让性别永远判成一致
  n = detectOverrides('她是女孩', { gender: 'female' }, BASE);
  check('★ 性别一致就不报（female 不该被 male 的 includes 骗过）', n.length === 0, JSON.stringify(n));
  n = detectOverrides('她是女孩', { gender: 'male' }, BASE);
  check('★ 性别不一致就要报', n.some((x) => /性别/.test(x)), JSON.stringify(n));

  // 成都的"都"曾经被当成虚词排除，导致抠不出来
  n = detectOverrides('她是成都人', { city: '重庆' }, BASE);
  check('★ "成都人"能抠出来（"都"是城市名的一部分）',
    n.some((x) => /成都/.test(x)), JSON.stringify(n));

  // 名字允许模型补全姓氏
  n = detectOverrides('她叫小雨', { name: '林小雨' }, BASE);
  check('★ 名字被补上姓氏不算改（小雨→林小雨）', n.length === 0, JSON.stringify(n));

  n = detectOverrides('随便写点什么', { name: '完全不同的', age: 99 }, BASE);
  check('描述里没提的字段不报', n.length === 0, JSON.stringify(n));
}

console.log('');
console.log('四之二、抠取明确值');
console.log('─'.repeat(64));
{
  check('抠名字', extractExplicit('她叫小雨').name === '小雨');
  check('抠名字（带引号）', extractExplicit('名字叫「小雨」').name === '小雨');
  check('抠城市（住在）', extractExplicit('她住在成都').city === '成都');
  check('抠城市（成都人）', extractExplicit('她是成都人').city === '成都');
  check('抠年龄', extractExplicit('她 26 岁').age === 26);
  check('抠年龄（周岁）', extractExplicit('26周岁').age === 26);
  check('抠性别（女）', extractExplicit('她是个姑娘').gender === 'female');
  check('抠性别（男）', extractExplicit('他是个男孩').gender === 'male');
  check('没说的就是 undefined', extractExplicit('随便聊聊').name === undefined);
  check('空串不崩', Object.keys(extractExplicit('')).length === 0);
  check('null 不崩', Object.keys(extractExplicit(null)).length === 0);
}

console.log('');
console.log('五、输入长度要拦');
console.log('─'.repeat(64));
{
  const short = await forgePersona({ cfg: { brain: {} }, template: '猫' });
  check('太短的描述被拦下', !short.ok && /太短/.test(short.reason), short.reason);

  const long = await forgePersona({ cfg: { brain: {} }, template: 'a'.repeat(2500) });
  check('太长的描述被拦下', !long.ok && /太长/.test(long.reason), long.reason);
}

console.log('');
console.log('六、字段清单要对得上配置');
console.log('─'.repeat(64));
{
  const missing = FORGE_FIELDS.filter((f) => !(f in BASE));
  check('FORGE_FIELDS 都在配置里有对应', missing.length === 0, `缺: ${missing.join(',')}`);
}

console.log('');
console.log('═'.repeat(64));
console.log(`通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
