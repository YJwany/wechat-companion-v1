// 验证指令协议：解析准确、剥离干净、护栏生效。
import { parseCommands, hasCommands, filterCommands, emptyUsage, PER_DAY } from '../src/soul/commands.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name} ${extra}`); fail++; }
};

console.log('一、解析与剥离');
console.log('─'.repeat(64));
{
  const r = parseCommands('好啊，那我也去睡了<sticker:晚安猫>');
  check('文字被剥离干净', r.text === '好啊，那我也去睡了', `实际 "${r.text}"`);
  check('解析出 1 个指令', r.commands.length === 1);
  check('类型正确', r.commands[0]?.kind === 'sticker');
  check('名字正确', r.commands[0]?.arg === '晚安猫', `实际 "${r.commands[0]?.arg}"`);
}
{
  const r = parseCommands('你看这个<image:窗外的雨.jpg>');
  check('image 指令能解析', r.commands[0]?.kind === 'image' && r.commands[0]?.arg === '窗外的雨.jpg');
  check('文字干净', r.text === '你看这个', `实际 "${r.text}"`);
}
{
  const r = parseCommands('好<sticker:晚安猫><remember:他不吃辣>');
  check('一条回复能带多个不同指令', r.commands.length === 2);
  check('顺序保持', r.commands[0].kind === 'sticker' && r.commands[1].kind === 'remember');
  check('文字只剩"好"', r.text === '好', `实际 "${r.text}"`);
}
{
  const r = parseCommands('中文冒号也行<sticker：猫>');
  check('中文冒号兼容', r.commands.length === 1 && r.commands[0].arg === '猫');
}
{
  const r = parseCommands('不带名字<sticker:>');
  check('空名字也算指令（随机挑一个）', r.commands.length === 1 && r.commands[0].arg === '');
}
{
  const r = parseCommands('这是普通的<尖括号>文字，还有 a<b 这种');
  check('不是指令的尖括号不动它', r.commands.length === 0 && r.text.includes('<尖括号>'),
    `实际 "${r.text}"`);
}

console.log('');
console.log('二、单条回复内限次（护栏 1）');
console.log('─'.repeat(64));
{
  const r = parseCommands('一<sticker:猫>二<sticker:狗>三<sticker:鸟>');
  check('3 个 sticker 只留 1 个', r.commands.filter((c) => c.kind === 'sticker').length === 1);
  check('多余的标记也被删掉', !r.text.includes('sticker'), `残留: "${r.text}"`);
}
{
  const r = parseCommands('看<image:a.jpg>还有<image:b.jpg>');
  check('2 个 image 只留 1 个', r.commands.filter((c) => c.kind === 'image').length === 1);
}

console.log('');
console.log('三、每日上限（护栏 2）');
console.log('─'.repeat(64));
{
  const day = '2026-09-19';
  let usage = emptyUsage(day);
  let totalOk = 0;
  // 连发 20 次表情包
  for (let i = 0; i < 20; i++) {
    const r = filterCommands([{ kind: 'sticker', arg: `猫${i}` }], usage, day);
    usage = r.usage;
    totalOk += r.ok.length;
  }
  check(`每天最多 ${PER_DAY.sticker} 个表情包`, totalOk === PER_DAY.sticker, `实际发了 ${totalOk} 个`);

  const over = filterCommands([{ kind: 'sticker', arg: '再来一个' }], usage, day);
  check('超限的被拦下', over.ok.length === 0 && over.dropped.length === 1);
  check('拦下时说明了原因', /上限/.test(over.dropped[0]?.why ?? ''), `实际 "${over.dropped[0]?.why}"`);
}
{
  const day = '2026-09-19';
  const r1 = filterCommands([{ kind: 'sticker', arg: '晚安猫' }], emptyUsage(day), day);
  const r2 = filterCommands([{ kind: 'sticker', arg: '晚安猫' }], r1.usage, day);
  check('连续两张一样的会被压掉', r2.ok.length === 0 && /重复/.test(r2.dropped[0]?.why ?? ''));
  const r3 = filterCommands([{ kind: 'sticker', arg: '别的猫' }], r2.usage, day);
  check('换成别的就放行', r3.ok.length === 1);
}
{
  const d1 = filterCommands([{ kind: 'sticker', arg: 'a' }], emptyUsage('2026-09-19'), '2026-09-19');
  const d2 = filterCommands([{ kind: 'sticker', arg: 'a' }], d1.usage, '2026-09-20');
  check('跨天自动重置', d2.ok.length === 1);
}

console.log('');
console.log('四、hasCommands 快速判定');
console.log('─'.repeat(64));
check('有指令时返回 true', hasCommands('好<sticker:猫>') === true);
check('普通文字返回 false', hasCommands('今天天气不错') === false);
check('不完整的尖括号不算指令', hasCommands('今天天气<不错') === false);
check('只写类型没闭合也不算', hasCommands('好<sticker:猫') === false);
check('空值不炸', hasCommands('') === false && hasCommands(null) === false);

console.log('');
console.log('═'.repeat(64));
console.log(`通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
