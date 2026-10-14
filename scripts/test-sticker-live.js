// 验证：她真的会自己挑表情包/照片吗？（真调模型）
import { Companion } from '../src/companion.js';

const c = new Companion();
const PEER = 'peer-sticker-test';
delete c.state.histories?.[PEER];
c.histories.delete(PEER);

// 挑几个"该发表情包"的场景
const scenes = [
  '哈哈哈哈哈笑死我了',
  '我今天加班到十点，累死了',
  '我跟你说个事，我升职了',
  '晚安啦',
  '在吗',
];

console.log('她会自己发表情包吗？（真调模型）');
console.log('═'.repeat(66));

let stickerCount = 0;
let imageCount = 0;
let textCount = 0;

for (const text of scenes) {
  const msg = { fromUserId: PEER, text, items: [], contextToken: '' };
  const history = c.getHistory(PEER);
  const r = await c.soul.respond(msg, history);
  if (!r) { console.log(`我: ${text}\n她: (无回复)\n`); continue; }

  const cmds = r.commands ?? [];
  const st = cmds.filter((x) => x.kind === 'sticker');
  const im = cmds.filter((x) => x.kind === 'image');
  if (st.length) stickerCount++;
  if (im.length) imageCount++;
  if (r.chunks.length) textCount++;

  console.log(`我: ${text}`);
  console.log(`她: ${r.chunks.join(' / ') || '(只发图不说话)'}`);
  if (cmds.length) console.log(`   [指令] ${cmds.map((x) => `${x.kind}:${x.arg || '(随机)'}`).join(', ')}`);
  console.log('');

  history.push({ role: 'user', content: text });
  history.push({ role: 'assistant', content: r.raw });
  c.setHistory(PEER, history);
}

console.log('═'.repeat(66));
console.log(`发表情包: ${stickerCount}/${scenes.length} 次`);
console.log(`发照片  : ${imageCount}/${scenes.length} 次`);
console.log(`有文字  : ${textCount}/${scenes.length} 次`);
console.log('');
if (stickerCount === 0) {
  console.log('⚠️  她一次都没发表情包 —— 提示词可能没说服她，需要调整');
} else if (stickerCount > scenes.length * 0.6) {
  console.log('⚠️  发得太频繁了，护栏或提示词要收紧');
} else {
  console.log('✓ 频率看起来合理');
}

delete c.state.histories[PEER];
c.saveState();
