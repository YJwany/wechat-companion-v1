// 集成检查：重逢 + 纪念日同时触发时，两个提示要能合并进同一轮。
import { Companion } from '../src/companion.js';
import { reunionHint } from '../src/soul/longing.js';
import { milestoneHint } from '../src/soul/milestones.js';

const c = new Companion();
const PEER = 'peer-hint-combo';
c.soul.relations.delete(PEER);
delete c.state.histories?.[PEER];
delete c.state.reunions?.[PEER];
c.state.milestones = {};
c.histories.delete(PEER);

// 造一个"认识 100 天 + 失联两天"的场面
c.state.metAt = new Date(Date.now() - 100 * 86_400_000).toISOString();
c.state.lastUserAt = new Date(Date.now() - 48 * 3_600_000).toISOString();

// 打底对话
{
  const h = c.getHistory(PEER);
  const r = await c.soul.respond({ fromUserId: PEER, text: '在吗', items: [], contextToken: '' }, h);
  if (r) { h.push({ role: 'user', content: '在吗' }); h.push({ role: 'assistant', content: r.raw }); c.setHistory(PEER, h); }
  c.soul.relations.delete(PEER);
  c.state.milestones = {};
  c.state.reunions = {};
}

// 复现 handleMessage 的提示拼装逻辑
const silentHours = c.silentHours();
const hints = [];

const reunion = c.reunion.check(PEER, silentHours);
if (reunion.settle) {
  hints.push(reunionHint(reunion.tone, silentHours));
  c.reunion.settle(PEER);
}
const mile = c.milestones.check(c.state.metAt, new Date());
if (mile.fire) {
  hints.push(milestoneHint(mile.milestone, { relation: c.soul.relationFor(PEER) }));
  c.milestones.mark(mile.milestone.days);
}

const combined = hints.filter(Boolean).join('\n\n');
console.log('场景：认识 100 天 + 失联 48 小时');
console.log('═'.repeat(66));
console.log('重逢触发:', reunion.settle, '/ 语气:', reunion.tone);
console.log('纪念日触发:', mile.fire, '/', mile.milestone?.label);
console.log('');
console.log('合并后的提示:');
console.log(combined.split('\n').map((l) => '  ' + l).join('\n'));
console.log('');

const ok1 = combined.includes('【他刚回来】');
const ok2 = combined.includes('【今天是个特别的日子】');
const ok3 = !combined.includes('undefined') && !combined.includes('null');
console.log(`包含重逢提示: ${ok1 ? '✓' : '✗'}`);
console.log(`包含纪念日提示: ${ok2 ? '✓' : '✗'}`);
console.log(`没有 undefined/null 漏进去: ${ok3 ? '✓' : '✗'}`);

// 真的发一轮，看两个提示是否都被用上
const msg = { fromUserId: PEER, text: '我回来了', items: [], contextToken: '' };
if (combined) msg.hint = combined;
const h2 = c.getHistory(PEER);
const r = await c.soul.respond(msg, h2);
console.log('');
console.log('她这次说:', r?.chunks.join(' / ') ?? '(没说话)');

// 清理
c.soul.relations.delete(PEER);
delete c.state.histories?.[PEER];
c.state.milestones = {};
c.state.reunions = {};
c.state.metAt = '';
c.histories.delete(PEER);
c.saveState();
