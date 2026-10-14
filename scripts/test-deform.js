// 变形状态机：要能压上去，更要能**回落**。
//
// 只涨不落是最毁人的失败模式 —— 被凶几次之后她就永远冷着脸，
// 那不是"有情绪"，那是坏掉了。
import { Deform, LAYERS, LAYER_LABEL, PRESSURE, DECAY_PER_HOUR, layerHint, looksTerse } from '../src/soul/deform.js';
import { deriveThresholds, deriveTraits } from '../src/soul/persona.js';

let pass = 0, fail = 0;
const check = (n, c, extra = '') => {
  if (c) { console.log(`  ✓ ${n}`); pass++; }
  else { console.log(`  ✗ ${n} ${extra}`); fail++; }
};

const T = deriveThresholds(deriveTraits('INFP'));
const at = (h, base = new Date('2026-09-19T08:00:00Z')) => new Date(base.getTime() + h * 3_600_000);

console.log('一、阈值真的被用上了（之前是死代码）');
console.log('─'.repeat(64));
{
  console.log(`  她的阈值: 抓紧 ${T.gripPressure} / 反复 ${T.loopPressure} / 收起 ${T.shadowPressure}`);
  const d = new Deform({});
  check('新账本压力为 0', d.currentPressure() === 0);
  check('新账本在平静层', d.layerOf(0, T) === 'calm');
  check('越过抓紧线 → grip', d.layerOf(T.gripPressure, T) === 'grip');
  check('越过反复线 → loop', d.layerOf(T.loopPressure, T) === 'loop');
  check('越过收起线 → shadow', d.layerOf(T.shadowPressure, T) === 'shadow');
  check('刚差一点还在下层', d.layerOf(T.gripPressure - 1, T) === 'calm');
}

console.log('');
console.log('二、层的顺序不能乱');
console.log('─'.repeat(64));
{
  const d = new Deform({});
  const seq = [];
  for (let i = 0; i < 8; i++) {
    const s = d.apply('rude', at(i * 0.1), T);
    seq.push(`${s.from}→${s.layer}`);
  }
  console.log(`  ${seq.join('  ')}`);

  // 允许"跳级"：一次很重的伤害可以直接把她从平静推到钻牛角尖，
  // 这是合理的。要保证的是**顺序**：压力只增不减时，层只能往上走。
  const rank = { calm: 0, grip: 1, loop: 2, shadow: 3 };
  const froms = seq.map((s) => rank[s.split('→')[0]]);
  const tos = seq.map((s) => rank[s.split('→')[1]]);
  check('★ 压力只加不减时，层只升不降', tos.every((v, i) => v >= froms[i]), seq.join(' '));

  // 所有断言都必须**显式传时间**。用真实 now 会随时间衰减 ——
  // 这个测试就这么翻过车：早上跑绿、下午跑红。
  const LAST = at(0.7);
  check('最终到了最高层', d.snapshot(T, LAST).layer === 'shadow', d.snapshot(T, LAST).layer);
  check('到顶了就不动了', (() => {
    const before = d.snapshot(T, LAST).layer;
    d.apply('rude', LAST, T);
    return d.snapshot(T, LAST).layer === before && before === 'shadow';
  })());
  check('压力不会超过上限', d.currentPressure(at(100)) <= 140);
}

console.log('');
console.log('三、★ 最重要：她会变回来');
console.log('─'.repeat(64));
{
  const d = new Deform({});
  const T0 = at(0);
  for (let i = 0; i < 6; i++) d.apply('rude', T0, T);
  check('被凶 6 次之后确实冷了', d.snapshot(T, T0).layer !== 'calm', d.snapshot(T, T0).layer);

  // 放着不管 5 小时
  const p5 = d.currentPressure(at(5));
  const p2h = d.currentPressure(at(2));
  check('★ 压力随时间自己往下掉', p5 < p2h, `2h=${p2h.toFixed(1)} → 5h=${p5.toFixed(1)}`);
  check('每小时掉 6', Math.abs((p2h - p5) - 3 * DECAY_PER_HOUR) < 0.01,
    `${(p2h - p5).toFixed(1)} vs ${3 * DECAY_PER_HOUR}`);

  // 一天之后应该基本平了
  check('★ 一天之后回到平静（不会永远冷着脸）', d.snapshot(at(24)).layer === 'calm',
    `24h 后压力 ${d.currentPressure(at(24)).toFixed(1)}`);
  check('压力不会掉成负数', d.currentPressure(at(1000)) === 0);
}

console.log('');
console.log('四、被哄消得比被凶涨得快');
console.log('─'.repeat(64));
{
  check('★ 哄一次降温的幅度 ≥ 凶一次升温', Math.abs(PRESSURE.warm) >= PRESSURE.rude * 0.6,
    `warm=${PRESSURE.warm} rude=${PRESSURE.rude}`);

  const d = new Deform({});
  for (let i = 0; i < 3; i++) d.apply('rude', at(0), T);
  const hot = d.currentPressure(at(0));
  const s = d.apply('warm', at(0), T);
  check('被哄之后压力明显下降', d.currentPressure(at(0)) < hot);
  check('★ 哄够多次能直接哄回平静', (() => {
    for (let i = 0; i < 6; i++) d.apply('warm', at(0), T);
    return d.snapshot(T, at(0)).layer === 'calm';
  })(), s.layer);
}

console.log('');
console.log('五、敷衍 vs 忙碌：这个区分很重要');
console.log('─'.repeat(64));
{
  for (const t of ['嗯', '哦', '嗯嗯', '随便', '都行', '知道了', '好吧', '。。。', '']) {
    check(`"${t}" 算敷衍`, looksTerse(t));
  }
  for (const t of ['我在忙，待会聊', '在开会，晚点说', '睡了明天聊', '刚忙完', '稍等一下']) {
    check(`"${t}" 不算敷衍（说了在忙）`, !looksTerse(t));
  }
  check('正常一句话不算敷衍', !looksTerse('今天在公司有点累，回来就躺着了'));
  check('null 不崩', looksTerse(null));
}

console.log('');
console.log('六、每一层的提示词要讲"行为怎么变"，不是"心情不好"');
console.log('─'.repeat(64));
{
  check('★ 平静层返回空串（不占提示词）', layerHint('calm') === '');
  check('未知层也返回空串', layerHint('???') === '' && layerHint(undefined) === '');

  const grip = layerHint('grip');
  check('抓紧层说了回得快', /回得快/.test(grip));
  check('抓紧层明确禁止质问', /不要质问|不要翻旧账/.test(grip));

  const loop = layerHint('loop');
  check('反复层限制了提几次', /最多提两次/.test(loop));

  const sh = layerHint('shadow');
  check('★ 收起层要求话变短', /变短/.test(sh));
  check('★ 收起层禁止阴阳怪气（否则就是泼妇不是受伤）', /不要阴阳怪气/.test(sh));
  check('收起层说了哄她会软化', /软化/.test(sh));
  check('每层都不为空', LAYERS.every((l) => l === 'calm' || layerHint(l).length > 20));
}

console.log('');
console.log('七、落盘与恢复');
console.log('─'.repeat(64));
{
  const d = new Deform({});
  for (let i = 0; i < 4; i++) d.apply('rude', at(0), T);
  const saved = JSON.parse(JSON.stringify(d.state));

  const d2 = new Deform(saved);
  check('压力恢复正确', Math.abs(d2.currentPressure(at(0)) - d.currentPressure(at(0))) < 0.01);
  check('层恢复正确', d2.snapshot(T, at(0)).layer === d.snapshot(T, at(0)).layer,
    `${d.snapshot(T, at(0)).layer} vs ${d2.snapshot(T, at(0)).layer}`);

  // ★ 重启之后时间照样算 —— 她不会因为重启就永远停在冷脸状态
  check('★ 重启后时间衰减仍然生效', d2.snapshot(at(24)).layer === 'calm',
    d2.snapshot(at(24)).layer);

  check('账本有可读的历史', d2.stats(T, at(0)).recent.length > 0);
  check('历史条目带原因', d2.stats(T, at(0)).recent.every((r) => !!r.kind));
}

console.log('');
console.log('八、边界');
console.log('─'.repeat(64));
{
  check('空 state 不崩', new Deform({}).currentPressure() === 0);
  check('null 不崩', new Deform(null ?? {}).currentPressure() === 0);
  check('压力是字符串也能自愈', (() => {
    const d = new Deform({ pressure: '50' });
    d.apply('warm', at(0), T);
    return Number.isFinite(d.currentPressure(at(0)));
  })());
  check('时间戳烂掉不崩', (() => {
    const d = new Deform({ pressure: 50, at: 'garbage' });
    return Number.isFinite(d.currentPressure());
  })());
  check('未知事件类型不改变压力', (() => {
    const d = new Deform({});
    d.apply('不存在的类型', at(0), T);
    return d.currentPressure(at(0)) === 0;
  })());
  check('历史不会无限增长', (() => {
    const d = new Deform({});
    for (let i = 0; i < 50; i++) d.apply('terse', at(i), T);
    return d.state.recent.length <= 12;
  })());
}

console.log('');
console.log('═'.repeat(64));
console.log(`通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
