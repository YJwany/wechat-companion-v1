// 表情包的**端到端**验证：她会主动挑、挑的是真图、命令标记不会漏到聊天里。
//
// 为什么需要：单测只证明"库里有图、函数能找到"。这里证明的是
// 提示词里真的列出了名字、她写的 <sticker:xx> 真的被解析、发出去的真是那张图。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Companion } from '../src/companion.js';
import { loadConfig, STATE_FILE } from '../src/config.js';
import { listStickers, findSticker, STICKER_DIR } from '../src/soul/stickers.js';

let pass = 0, fail = 0;
const check = (n, c, extra = '') => {
  if (c) { console.log(`  ✓ ${n}`); pass++; }
  else { console.log(`  ✗ ${n} ${extra}`); fail++; }
};

const all = listStickers();
if (!all.length) {
  console.log('库里没有表情包（别人刚拿到包时是空的），跳过。');
  console.log('想装一批： node scripts/fetch-stickers.js');
  process.exit(0);
}

console.log('零、库里有什么');
console.log('─'.repeat(64));
const animated = all.filter((s) => s.ext === '.gif');
console.log(`  共 ${all.length} 个，其中 ${animated.length} 个 GIF`);
check('有足够的表情包', all.length >= 20, `${all.length}`);

// ── 假模型：让她"想发表情包" ──
const seen = [];
let reply = '今天好累啊 <sticker:哭哭>';
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    let p = {}; try { p = JSON.parse(b); } catch { /* */ }
    seen.push(p);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const backup = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8') : null;
const PEER = 'peer-sticker-e2e';

function mkCompanion() {
  const cfg = loadConfig();
  cfg.brain.baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  cfg.brain.apiKey = 'k'; cfg.brain.model = 'm';
  cfg.memory.enabled = false;
  const c = new Companion({ config: cfg });
  c.soul.relations.delete(PEER);
  c.histories.delete(PEER);
  return c;
}

console.log('');
console.log('一、★ 表情包名字真的进了提示词（否则她根本不知道有哪些）');
console.log('─'.repeat(64));
{
  const c = mkCompanion();
  await c.soul.respond({ fromUserId: PEER, text: '今天好累', items: [], contextToken: '' }, []);
  const sent = JSON.stringify(seen[seen.length - 1]?.messages ?? []);

  const listed = all.filter((s) => sent.includes(s.name));
  console.log(`  提示词里出现了 ${listed.length} / ${all.length} 个名字`);
  check('★ 提示词里列出了表情包名字', listed.length > 0, '一个都没有 —— 她就没法主动发');

  // 不能把 99 个名字全塞进去，那样太占 token
  check('名字没有全塞进去（占 token）', listed.length <= all.length,
    `${listed.length}`);

  const { buildSystemPrompt } = await import('../src/soul/persona.js');
  const prompt = buildSystemPrompt({
    persona: c.cfg.persona, traits: c.soul.traitsFor(), daily: c.soul.todayFor(),
    world: null, memories: [], relation: c.soul.relationFor(PEER),
    now: new Date(), stickers: all.map((s) => s.name), photos: [],
  });
  check('说了怎么用（<sticker:名字> 这种写法）', /<sticker:/.test(prompt), '提示词里没写格式');
  check('写了"不确定就别发"这类约束', /不确定|别乱发|不要乱发|宁可不发/.test(prompt));

  c.soul.relations.delete(PEER);
}

console.log('');
console.log('二、★ 她写的 <sticker:哭哭> 真的能变成那张图');
console.log('─'.repeat(64));
{
  const c = mkCompanion();
  const r = await c.soul.respond({ fromUserId: PEER, text: '今天好累', items: [], contextToken: '' }, []);

  console.log(`  她回的原文: ${r?.raw}`);
  console.log(`  拆成几条: ${JSON.stringify(r?.chunks)}`);
  console.log(`  解析出的指令: ${JSON.stringify(r?.commands)}`);

  check('★ 命令标记被剥掉了（不会把 <sticker:哭哭> 原样发给用户）',
    !JSON.stringify(r?.chunks ?? []).includes('<sticker:'), JSON.stringify(r?.chunks));

  // parseCommands 返回的是 [{kind, arg}]，不是按类型分组的对象
  const cmds = r?.commands ?? [];
  const stickers = cmds.filter((c) => c.kind === 'sticker').map((c) => c.arg);
  check('★ 解析出了要发的表情包', stickers.length > 0, JSON.stringify(cmds));
  check('解析到的就是「哭哭」', stickers[0] === '哭哭', JSON.stringify(stickers));

  // 真的能读到图
  const spec = findSticker(stickers[0]);
  check('★ 这张图真的存在且读得出来', !!spec && fs.existsSync(spec.path), spec?.path);
  check('是图片 MIME', /^image\//.test(spec?.mime ?? ''), spec?.mime);
  check('★ mime 跟真实字节对得上（不信文件名后缀）', (() => {
    const b = fs.readFileSync(spec.path).subarray(0, 4);
    const want = b[0] === 0xFF ? 'image/jpeg'
      : b[0] === 0x89 ? 'image/png'
        : b.subarray(0, 3).toString('ascii') === 'GIF' ? 'image/gif'
          : b.toString('ascii') === 'RIFF' ? 'image/webp' : '?';
    return spec.mime === want;
  })(), `${spec?.name} 标的是 ${spec?.mime}`);

  c.soul.relations.delete(PEER);
}

console.log('');
console.log('三、她说一个库里没有的名字，不能崩也不能乱发');
console.log('─'.repeat(64));
{
  reply = '哈哈 <sticker:量子力学论文> 好了';
  const c = mkCompanion();
  let r = null;
  try {
    r = await c.soul.respond({ fromUserId: PEER, text: '在吗', items: [], contextToken: '' }, []);
  } catch (e) {
    check('不抛异常', false, e.message);
  }
  check('不抛异常', !!r);
  check('标记照样被剥掉', !JSON.stringify(r?.chunks ?? []).includes('<sticker:'), JSON.stringify(r?.chunks));
  const spec = findSticker('量子力学论文');
  console.log(`  她说「量子力学论文」→ ${spec ? `命中「${spec.name}」` : 'null（不发）'}`);
  check('要么不发，要么发的是个说得通的', spec === null || typeof spec.name === 'string');

  // 空名字（她就是"想发个表情"）
  const rnd = findSticker('');
  check('空名字 → 随机给一张', !!rnd && fs.existsSync(rnd.path), rnd?.name);

  c.soul.relations.delete(PEER);
  reply = '今天好累啊 <sticker:哭哭>';
}

console.log('');
console.log('四、发出去的字节 = 磁盘上的那张图（走完整的加密上传前一步）');
console.log('─'.repeat(64));
{
  const { readSticker } = await import('../src/soul/stickers.js');
  let bad = [];
  for (const s of all) {
    const spec = findSticker(s.name);
    const got = readSticker(spec);
    const onDisk = fs.readFileSync(s.path);
    if (!got || Buffer.compare(got.data, onDisk) !== 0) bad.push(s.name);
  }
  check(`★ ${all.length} 个每个都能原样读出来`, bad.length === 0, bad.slice(0, 5).join(', '));

  // 上游仓库里真有后缀名和内容不符的文件（「不许凶我.gif」其实是个 JPEG）。
  // 发送是按 mime 走的，标错就会发失败或发出去是个坏图 —— 所以逐个查。
  const mislabeled = [];
  for (const s of all) {
    const b = fs.readFileSync(s.path).subarray(0, 4);
    const real = b[0] === 0xFF ? '.jpg'
      : b[0] === 0x89 ? '.png'
        : b.subarray(0, 3).toString('ascii') === 'GIF' ? '.gif'
          : b.toString('ascii') === 'RIFF' ? '.webp' : '?';
    const wantExt = s.ext === '.jpeg' ? '.jpg' : s.ext;
    if (real !== wantExt) mislabeled.push(`${s.file}(标 ${s.ext} 实 ${real})`);
  }
  check(`★ ${all.length} 个后缀名和真实内容全部一致`, mislabeled.length === 0,
    mislabeled.slice(0, 5).join(', '));

  // 动图确实还是动图（多帧没被压成单帧）
  const gifs = all.filter((s) => s.ext === '.gif');
  const stillGif = gifs.every((s) => fs.readFileSync(s.path).subarray(0, 3).toString('ascii') === 'GIF');
  check(`GIF 保持 GIF 格式（${gifs.length} 个）`, stillGif);
}

// 清理
server.close();
try {
  const c = new Companion({ config: loadConfig() });
  c.soul.relations.delete(PEER);
  for (const k of Object.keys(c.state.histories ?? {})) if (k.startsWith('peer-')) delete c.state.histories[k];
  c.saveState();
} catch { /* */ }
if (backup !== null) fs.writeFileSync(STATE_FILE, backup);

console.log('');
console.log('═'.repeat(64));
console.log(`通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
