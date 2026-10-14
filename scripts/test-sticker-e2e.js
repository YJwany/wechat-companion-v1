// 端到端：让她真的发一个表情包到微信。
import { Companion } from '../src/companion.js';
import { findSticker, readSticker } from '../src/soul/stickers.js';

const c = new Companion();
const peer = c.cfg.moments.autoSendTo || c.cfg.channel.ilinkUserId;
if (!peer) { console.error('没有发送对象'); process.exit(1); }

console.log('端到端：发表情包到微信');
console.log('═'.repeat(60));
console.log('接收方:', peer);
console.log('');

// 先测"她自己触发"的完整路径
console.log('1. 让她自己决定（真调模型）');
const msg = { fromUserId: peer, text: '哈哈哈哈笑死我了', items: [], contextToken: '' };
const history = c.getHistory(peer);
const r = await c.soul.respond(msg, history);
console.log('   她说:', r?.chunks.join(' / '));
console.log('   她想发:', (r?.commands ?? []).map((x) => `${x.kind}:${x.arg}`).join(', ') || '(无)');
console.log('');

// 真的执行
if (r?.commands?.length) {
  console.log('2. 执行她的指令（真的发到微信）');
  await c.runCommands(peer, r.commands);
  console.log('   ✓ 执行完毕，去看微信');
} else {
  // 她这次没想发，那就直接测发送链路本身
  console.log('2. 她这次没发，改为直接测发送链路');
  const spec = findSticker('晚安猫');
  const data = readSticker(spec);
  await c.sendImageBuffer(peer, data.data);
  console.log(`   ✓ 已发「${spec.name}」到微信`);
}

console.log('');
console.log('3. 指令用量');
console.log('  ', JSON.stringify(c.state.commandUsage));
