// 真实验证"她眼中的你"：聊一段，然后看模型写出什么印象。
import fs from 'node:fs';
import { Companion } from '../src/companion.js';
import { updatePortrait, readPortrait, portraitBlock, PORTRAIT_FILE, shouldUpdate } from '../src/soul/portrait.js';

// 备份真实文件
const backup = fs.existsSync(PORTRAIT_FILE) ? fs.readFileSync(PORTRAIT_FILE, 'utf8') : null;
if (fs.existsSync(PORTRAIT_FILE)) fs.unlinkSync(PORTRAIT_FILE);

const c = new Companion();
const PEER = 'peer-portrait-live';
c.soul.relations.delete(PEER);
delete c.state.histories?.[PEER];
delete c.state.summaries?.[PEER];
c.histories.delete(PEER);

// 造一段有"性格信号"的对话 —— 看他是不是只会写空话
const turns = [
  '我今天加班到十点，老板又临时改需求',
  '其实还好，习惯了，我也不太会说累',
  '我妈让我周末回家吃饭，我有点不想去又不好意思说',
  '你怎么看，我该不该直接跟她说',
  '算了，我到时候看情况吧，先不说这个了',
  '你吃饭了吗，别又忙忘了',
  '我上次给你带的那本书你看了吗',
  '对了，我下周可能要去趟南京出差',
];

console.log('造一段对话（含性格信号），然后让她写印象');
console.log('═'.repeat(66));
for (const t of turns) {
  const h = c.getHistory(PEER);
  const r = await c.soul.respond({ fromUserId: PEER, text: t, items: [], contextToken: '' }, h);
  if (r) {
    h.push({ role: 'user', content: t });
    h.push({ role: 'assistant', content: r.raw });
    c.setHistory(PEER, h);
    console.log(`我: ${t}`);
    console.log(`她: ${r.chunks.join(' / ')}`);
  }
}

const total = c.msgCount(PEER);
console.log('');
console.log(`共聊了 ${total} 轮`);

console.log('');
console.log('═'.repeat(66));
console.log('触发印象更新');
const verdict = shouldUpdate(readPortrait(), total);
console.log('  该不该更新:', verdict.update, '—', verdict.reason);

const view = Object.assign([...c.getHistory(PEER)], {
  peer: PEER,
  summary: c.getHistory(PEER).summary ?? '',
});

const r = await updatePortrait({
  cfg: c.cfg,
  persona: c.cfg.persona,
  history: view,
  messageCount: total,
  logger: (lv, m) => console.log(`  [${lv}] ${m}`),
});

if (r.ok) {
  console.log('');
  console.log('★ 她眼中的他：');
  console.log('  ' + r.portrait.text);
  console.log('');
  console.log(`  （第 ${r.portrait.version} 版，基于 ${r.portrait.basedOn} 轮对话）`);
  console.log('');
  console.log('注入提示词的块:');
  console.log(portraitBlock(r.portrait).split('\n').map((l) => '  ' + l).join('\n'));

  // 落盘检查
  const re = readPortrait();
  console.log('');
  console.log('落盘后读回:', re?.text === r.portrait.text ? '✓ 一致' : '✗ 不一致');
  const c2 = new Companion();
  console.log('重启后她记得这个印象:', c2.soul.portrait?.text ? '✓' : '✗');
} else {
  console.log('更新失败:', r.reason);
}

// 还原
if (backup === null) { try { fs.unlinkSync(PORTRAIT_FILE); } catch { /* 无 */ } }
else fs.writeFileSync(PORTRAIT_FILE, backup);

c.soul.relations.delete(PEER);
delete c.state.histories?.[PEER];
c.histories.delete(PEER);
c.saveState();
