// 真调模型验证"兑现承诺"这条主动消息生成得对不对。
import { Companion } from '../src/companion.js';

const c = new Companion();
const daily = c.soul.todayFor(new Date());

const cases = [
  '我明天告诉你那本书有没有',
  '我一会儿发你照片',
  '等我问一下朋友',
];

for (const promise of cases) {
  const text = await c.composeProactive('promise', daily, { promise });
  console.log(`承诺: ${promise}`);
  console.log(`她的消息: ${text}`);
  const hasApology = /忘了|抱歉|对不起|不好意思/.test(text);
  const reasonable = text && text.length > 0 && text.length < 80;
  console.log(`  有内容且不过长: ${reasonable ? '✓' : '✗'} (${text?.length ?? 0} 字)`);
  console.log(`  没在道歉（不是"我忘了"）: ${!hasApology ? '✓' : '✗ 说了道歉词'}`);
  console.log('');
}
