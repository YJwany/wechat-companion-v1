// 用**真实收集到的回复**验证判重器，而不是编造的例句。
import { checkRepeat, similarity, containment, normalizeForCompare } from '../src/soul/repeat.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name} ${extra}`); fail++; }
};

console.log('一、用实测数据验证（这些是她真的说过的话）');
console.log('─'.repeat(68));

// 实测中相似度 0.83 的那一对 —— 必须被判为重复
const A = '就是挑了几本朋友需要的书，有点累';
const B = '今天就是挑选了几本朋友需要的书，有点累';
console.log(`  A: ${A}`);
console.log(`  B: ${B}`);
console.log(`  实测相似度: ${similarity(A, B).toFixed(2)}`);
const r1 = checkRepeat(B, [A]);
check('这一对必须判为重复', r1.repeat, `实际判定: ${r1.repeat}`);

// 实测中 0.52 的那一对 —— 边界，先看数值
const C = '挑了几本朋友需要的书，有点累 今天上午新到的那些旧书还蛮有意思的';
const D = '今天就是挑选了几本朋友需要的书，有点累';
console.log('');
console.log(`  相似度 0.52 的那对: ${similarity(C, D).toFixed(2)}`);
const r2 = checkRepeat(D, [C]);
console.log(`  判定: ${r2.repeat ? '重复' : '放行'}（阈值 0.7）`);

console.log('');
console.log('二、不该被判重的情况（误判会让她该说时不说）');
console.log('─'.repeat(68));
{
  const r = checkRepeat('今天书店来了一批旧书', ['我刚才在整理书架']);
  check('说的不是一回事 → 放行', !r.repeat, `被判重: ${r.reason}`);
}
{
  const r = checkRepeat('嗯', ['嗯']);
  check('短回应重复 → 放行（真人也会连着说"嗯"）', !r.repeat);
}
{
  const r = checkRepeat('哈哈', ['哈哈']);
  check('"哈哈"重复 → 放行', !r.repeat);
}
{
  const r = checkRepeat('好的', ['好的']);
  check('"好的"重复 → 放行', !r.repeat);
}
{
  const r = checkRepeat('我今天去了趟城南的书市，淘到一本绝版的诗集', ['今天店里人不多']);
  check('内容确实不同 → 放行', !r.repeat);
}

console.log('');
console.log('三、必须抓住的重复');
console.log('─'.repeat(68));
{
  const r = checkRepeat('今天有点累', ['今天有点累']);
  check('字面完全一样 → 判重', r.repeat);
}
{
  const r = checkRepeat('我在店里整理新到的旧书呢', ['在店里整理新到的旧书']);
  check('只差虚词 → 判重', r.repeat, `相似度 ${similarity('我在店里整理新到的旧书呢', '在店里整理新到的旧书').toFixed(2)}`);
}
{
  const r = checkRepeat('帮朋友挑了几本民谣的书', ['帮朋友找了一些民谣相关的书']);
  const c = containment('帮朋友挑了几本民谣的书', '帮朋友找了一些民谣相关的书');
  check('换说法讲同一件事 → 判重', r.repeat,
    `Jaccard ${similarity('帮朋友挑了几本民谣的书', '帮朋友找了一些民谣相关的书').toFixed(2)} / 包含度 ${c.score.toFixed(2)} / 共同字 ${c.shared}`);
}

console.log('');
console.log('四、归一化');
console.log('─'.repeat(68));
check('标点被去掉', normalizeForCompare('你好，世界！') === '你好世界');
check('空格被去掉', normalizeForCompare('a b c') === 'abc');
check('空值不炸', normalizeForCompare(null) === '');

console.log('');
console.log('═'.repeat(68));
console.log(`通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
