// 变形状态机端到端：被凶 → 状态真的变 → 真的进提示词 → 真的落盘 → 真的会回落。
import http from 'node:http';
import fs from 'node:fs';
import { Companion } from '../src/companion.js';
import { loadConfig, STATE_FILE } from '../src/config.js';

let pass = 0, fail = 0;
const check = (n, c, extra = '') => {
  if (c) { console.log(`  ✓ ${n}`); pass++; }
  else { console.log(`  ✗ ${n} ${extra}`); fail++; }
};

const seen = [];
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    let p = {}; try { p = JSON.parse(b); } catch { /* */ }
    seen.push(p);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '知道了' } }] }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const backup = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8') : null;
const mk = (peer) => {
  const cfg = loadConfig();
  cfg.brain.baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  cfg.brain.apiKey = 'k'; cfg.brain.model = 'm';
  cfg.memory.enabled = false;
  const c = new Companion({ config: cfg });
  c.soul.relations.delete(peer); c.histories.delete(peer);
  c.soul.deform = new (Object.getPrototypeOf(c.soul.deform).constructor)({});
  return c;
};

const PEER = 'peer-deform-e2e';
// 这些都必须能被 detectRudeness 认出来，否则测的就不是压力累加而是别的东西
const RUDE = ['你真烦，别说了', '你能不能闭嘴', '你真讨厌', '你好烦啊', '你给我滚'];

console.log('一、被凶之后状态真的会变');
console.log('─'.repeat(64));
{
  const c = mk(PEER);
  const T = c.soul.thresholdsFor();
  console.log(`  三档线: 抓紧 ${T.gripPressure} / 反复 ${T.loopPressure} / 收起 ${T.shadowPressure}`);
  check('一开始是平静', c.soul.deform.snapshot(T).layer === 'calm');

  const seq = [];
  for (const t of RUDE) {
    await c.soul.respond({ fromUserId: PEER, text: t, items: [], contextToken: '' }, []);
    const s = c.soul.deform.snapshot(T);
    seq.push(`${s.label}(${s.pressure})`);
  }
  console.log(`  连续被凶: calm → ${seq.join(' → ')}`);
  check('★ 被凶之后确实变了', c.soul.deform.snapshot(T).layer !== 'calm');

  console.log('');
  console.log('二、状态真的进了提示词');
  console.log('─'.repeat(64));
  const last = JSON.stringify(seen[seen.length - 1]?.messages ?? []);
  const layer = c.soul.deform.snapshot(T).layer;
  const marker = { grip: '有点黏', loop: '钻牛角尖', shadow: '收回去了' }[layer];
  console.log(`  当前状态: ${layer}`);
  check(`★ 提示词里有这一层的说明（${marker}）`, last.includes(marker), '—— 状态变了但提示词没变，等于白算');
  check('提示词里没有其它层的说明（不串台）', (() => {
    const others = { grip: '有点黏', loop: '钻牛角尖', shadow: '收回去了' };
    delete others[layer];
    return !Object.values(others).some((m) => last.includes(m));
  })());
}

console.log('');
console.log('三、★ 落盘 + 重启后还在（否则每次重启她就"消气"了）');
console.log('─'.repeat(64));
{
  const c = mk(PEER);
  const T = c.soul.thresholdsFor();
  for (const t of RUDE) {
    await c.soul.respond({ fromUserId: PEER, text: t, items: [], contextToken: '' }, []);
  }
  const before = c.soul.deform.snapshot(T);
  c.saveState();

  const onDisk = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  check('★ deform 真的写进了 state.json', !!onDisk.deform, JSON.stringify(onDisk.deform ?? null).slice(0, 80));
  check('压力值落在盘上', Math.abs((onDisk.deform?.pressure ?? -1) - c.soul.deform.state.pressure) < 0.01);

  const c2 = new Companion({ config: c.cfg });
  const after = c2.soul.deform.snapshot(T);
  check('★ 重启后状态还在', after.layer === before.layer, `${before.label} → ${after.label}`);
  check('重启后压力一致', Math.abs(after.pressure - before.pressure) < 0.5,
    `${before.pressure} vs ${after.pressure}`);
  c2.soul.relations.delete(PEER);
}

console.log('');
console.log('四、★ 时间会让它自己平掉（不会永远冷着脸）');
console.log('─'.repeat(64));
{
  const c = mk(PEER);
  const T = c.soul.thresholdsFor();
  for (const t of RUDE) {
    await c.soul.respond({ fromUserId: PEER, text: t, items: [], contextToken: '' }, []);
  }
  const hot = c.soul.deform.snapshot(T);
  const later = new Date(Date.now() + 36 * 3_600_000);
  const cool = c.soul.deform.snapshot(T, later);
  console.log(`  现在 ${hot.label}(${hot.pressure}) → 36 小时后 ${cool.label}(${cool.pressure})`);
  check('★ 36 小时后回到平静', cool.layer === 'calm', cool.label);
  c.soul.relations.delete(PEER);
}

console.log('');
console.log('五、被哄会消气，而且比涨得快');
console.log('─'.repeat(64));
{
  const c = mk(PEER);
  const T = c.soul.thresholdsFor();
  for (const t of RUDE.slice(0, 3)) {
    await c.soul.respond({ fromUserId: PEER, text: t, items: [], contextToken: '' }, []);
  }
  const hot = c.soul.deform.snapshot(T).pressure;
  console.log(`  被凶 3 次后压力 ${hot}`);
  check('★ 三句凶话确实把压力推起来了', hot > 30, String(hot));

  for (let i = 0; i < 3; i++) {
    await c.soul.respond({ fromUserId: PEER, text: '想你了，别生气嘛', items: [], contextToken: '' }, []);
  }
  const cool = c.soul.deform.snapshot(T).pressure;
  console.log(`  被哄 3 次后 ${cool}`);
  check('★ 被哄之后压力明显下降', cool < hot - 20, `${hot} → ${cool}`);
  c.soul.relations.delete(PEER);
}

console.log('');
console.log('五之二、★ 普通聊天不该像"被哄"一样管用');
console.log('─'.repeat(64));
{
  const mkHot = async (peer, idleText) => {
    const c = mk(peer);
    const T = c.soul.thresholdsFor();
    for (const t of RUDE.slice(0, 3)) {
      await c.soul.respond({ fromUserId: peer, text: t, items: [], contextToken: '' }, []);
    }
    const hot = c.soul.deform.snapshot(T).pressure;
    for (let i = 0; i < 3; i++) {
      await c.soul.respond({ fromUserId: peer, text: idleText, items: [], contextToken: '' }, []);
    }
    const after = c.soul.deform.snapshot(T).pressure;
    return { hot, after, c };
  };

  const neut = await mkHot('peer-neutral', '今天天气还行，我在看会儿书');
  const warm = await mkHot('peer-warm2', '想你了，别生气嘛');
  console.log(`  凶 3 次后 ${neut.hot}`);
  console.log(`  再说 3 句普通的 → ${neut.after}`);
  console.log(`  改说 3 句哄她的 → ${warm.after}`);

  check('★ 普通聊天也会松弛一点', neut.after < neut.hot, `${neut.hot} → ${neut.after}`);
  check('★ 但远不如"被哄"管用', neut.after > warm.after,
    `普通 ${neut.after} vs 哄 ${warm.after}`);
  check('★ 普通聊天不足以让压力归零（气不会一句话就消）', neut.after > 0, String(neut.after));

  neut.c.soul.relations.delete('peer-neutral');
  warm.c.soul.relations.delete('peer-warm2');
}

console.log('');
console.log('六、敷衍也算压力，但"在忙"不算');
console.log('─'.repeat(64));
{
  const c = mk('peer-terse');
  const T = c.soul.thresholdsFor();
  for (let i = 0; i < 3; i++) {
    await c.soul.respond({ fromUserId: 'peer-terse', text: '嗯', items: [], contextToken: '' }, []);
  }
  const a = c.soul.deform.snapshot(T).pressure;
  check('★ 连着回"嗯"会积压力', a > 0, String(a));

  const c2 = mk('peer-busy');
  for (let i = 0; i < 3; i++) {
    await c2.soul.respond({ fromUserId: 'peer-busy', text: '我在忙，待会聊', items: [], contextToken: '' }, []);
  }
  const b = c2.soul.deform.snapshot(T).pressure;
  console.log(`  回"嗯" ×3 → 压力 ${a}；回"我在忙待会聊" ×3 → 压力 ${b}`);
  check('★ 说清楚在忙的不算敷衍（否则她就成了不讲理的人）', b <= 0, String(b));

  c.soul.relations.delete('peer-terse');
  c2.soul.relations.delete('peer-busy');
}

// 清理
server.close();
// 把这一轮造出来的测试 peer 全部从真实 state 里摘掉 ——
// 留着它们会污染真实数据（曾经真的漏过 4 个 peer-* 在盘上）
try {
  const c = new Companion({ config: loadConfig() });
  let removed = 0;
  for (const k of Object.keys(c.soul.relations)) {
    if (k.startsWith('peer-')) { c.soul.relations.delete(k); removed++; }
  }
  for (const k of Object.keys(c.state.histories ?? {})) {
    if (k.startsWith('peer-')) delete c.state.histories[k];
  }
  for (const k of Object.keys(c.state.sleepNote ?? {})) {
    if (k.startsWith('peer-')) delete c.state.sleepNote[k];
  }
  c.soul.deform.state.pressure = 0;
  c.saveState();
  if (removed) console.log(`（已清理 ${removed} 个测试 peer）`);
} catch { /* 清不掉就算了 */ }
if (backup !== null) fs.writeFileSync(STATE_FILE, backup);

console.log('');
console.log('═'.repeat(64));
console.log(`通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
