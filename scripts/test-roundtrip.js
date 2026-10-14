// 落盘往返测试：Soul.serialize() 产出的每一项，都必须能被 hydrate() 装回去。
//
// 为什么单独做这个：变形状态机接好之后，"重启后状态还在"的测试**失败了**，
// 原因是 hydrate() 支持 deform，但 companion 的调用点只传了 relations 和 drift。
// 这类"新加一个持久化字段但忘了接线"的 bug 已经犯过三次
// （addressTerm、reunions、deform），所以这里做一条**通用**的守卫：
// 只要 serialize 多了字段而 hydrate 不认，或者调用点漏传，这条测试就会红。

import { Companion } from '../src/companion.js';
import { Soul } from '../src/soul/soul.js';
import { loadConfig } from '../src/config.js';

let pass = 0, fail = 0;
const check = (n, c, extra = '') => {
  if (c) { console.log(`  ✓ ${n}`); pass++; }
  else { console.log(`  ✗ ${n} ${extra}`); fail++; }
};

console.log('一、Soul.serialize() 的每一项，hydrate() 都得认');
console.log('─'.repeat(64));
{
  const cfg = loadConfig();
  const s = new Soul({ cfg, memory: { recall: () => [], stats: () => ({}) }, world: {}, logger: () => {} });
  const keys = Object.keys(s.serialize());
  console.log(`  serialize 产出: ${keys.join(', ')}`);

  const s2 = new Soul({ cfg, memory: { recall: () => [], stats: () => ({}) }, world: {}, logger: () => {} });
  const before = JSON.stringify(s2.serialize());

  // 造一份"有内容"的状态，装回去看有没有丢
  const state = {
    relations: { p1: { sentenceCount: 7 } },
    drift: { rude: 3, warm: 5, chats: 9, traits: null, updatedAt: 'W1' },
    deform: { pressure: 42, at: new Date().toISOString(), layer: 'grip', recent: [] },
  };
  s2.hydrate(state);
  const out = s2.serialize();

  for (const k of keys) {
    const got = out[k];
    const has = got !== undefined && got !== null
      && (typeof got !== 'object' || Object.keys(got).length > 0);
    check(`hydrate 认 ${k}`, has, JSON.stringify(got));
  }
  check('空状态不会让 serialize 崩', typeof before === 'string');
}

console.log('');
console.log('二、★ Companion 的调用点有没有漏传（这次真踩到的坑）');
console.log('─'.repeat(64));
{
  const c = new Companion();
  // 给每一样 soul 状态都塞上可识别的值
  c.soul.relations.set('peer-rt', { sentenceCount: 11 });
  c.soul.drift.rude = 4;
  c.soul.drift.warm = 6;
  c.soul.deform.state.pressure = 55;
  c.soul.deform.state.at = new Date().toISOString();
  c.saveState();

  const c2 = new Companion();
  const snap = c2.soul.serialize();

  check('★ relations 装回来了', snap.relations['peer-rt']?.sentenceCount === 11,
    JSON.stringify(snap.relations['peer-rt']));
  check('★ drift 装回来了', snap.drift.rude === 4 && snap.drift.warm === 6,
    `rude=${snap.drift.rude} warm=${snap.drift.warm}`);
  check('★ deform 装回来了（曾经这里漏传，重启就"消气"）',
    Math.abs(c2.soul.deform.currentPressure() - 55) < 1,
    String(c2.soul.deform.currentPressure()));

  // 清理
  c2.soul.relations.delete('peer-rt');
  c2.soul.deform.state.pressure = 0;
  c2.saveState();
  c.soul.relations.delete('peer-rt');
  // 关系表可能还留着测试 peer，清干净再落盘
  for (const k of Object.keys(c2.soul.relations)) {
    if (k.startsWith('peer-')) c2.soul.relations.delete(k);
  }
  c2.saveState();
}

console.log('');
console.log('三、STATE_SHAPE 里的键，saveState 之后都得在盘上');
console.log('─'.repeat(64));
{
  const c = new Companion();
  c.saveState();
  const disk = JSON.parse((await import('node:fs')).readFileSync(
    (await import('../src/config.js')).STATE_FILE, 'utf8',
  ));
  const expected = ['relations', 'drift', 'deform', 'seen', 'contextTokens',
    'reunions', 'milestones', 'sleepNote', 'metAt', 'lastUserAt'];
  for (const k of expected) {
    check(`state.json 里有 ${k}`, disk[k] !== undefined, JSON.stringify(disk[k]));
  }
}

console.log('');
console.log('═'.repeat(64));
console.log(`通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
