// 验证"她眼中的你"：更新节奏、提示词分寸、清洗、落盘。
import fs from 'node:fs';
import {
  shouldUpdate, buildPortraitPrompt, cleanPortrait, portraitBlock,
  readPortrait, writePortrait, PORTRAIT_FILE, MAX_LEN, MIN_NEW_CHATS,
} from '../src/soul/portrait.js';

let pass = 0, fail = 0;
const check = (n, c, extra = '') => {
  if (c) { console.log(`  ✓ ${n}`); pass++; }
  else { console.log(`  ✗ ${n} ${extra}`); fail++; }
};

// 备份真实文件，测完还原（这是真数据，不能污染）
const backup = fs.existsSync(PORTRAIT_FILE) ? fs.readFileSync(PORTRAIT_FILE, 'utf8') : null;
const restore = () => {
  if (backup === null) { try { fs.unlinkSync(PORTRAIT_FILE); } catch { /* 本来就没有 */ } }
  else fs.writeFileSync(PORTRAIT_FILE, backup);
};

try {
  if (fs.existsSync(PORTRAIT_FILE)) fs.unlinkSync(PORTRAIT_FILE);

  console.log('一、更新节奏（聊两句就重写 = 神经质，不是了解）');
  console.log('─'.repeat(64));
  check('刚开始聊，样本不够 → 不更新', !shouldUpdate(null, 3).update);
  check(`聊够 ${MIN_NEW_CHATS} 条 → 开始形成印象`, shouldUpdate(null, MIN_NEW_CHATS).update);
  check('还没形成印象时给出原因', /还没有印象/.test(shouldUpdate(null, MIN_NEW_CHATS).reason));

  const p = { text: '他话不多', basedOn: 20, updatedAt: new Date().toISOString() };
  check('新增对话不够 → 不更新', !shouldUpdate(p, 22).update, shouldUpdate(p, 22).reason);
  check('新增够了但刚更新过 → 不更新', !shouldUpdate(p, 40).update,
    shouldUpdate(p, 40).reason);

  const old = { text: '他话不多', basedOn: 20, updatedAt: new Date(Date.now() - 30 * 3_600_000).toISOString() };
  check('新增够了且隔了够久 → 更新', shouldUpdate(old, 40).update,
    shouldUpdate(old, 40).reason);
  check('刚好卡在间隔边界之前 → 不更新',
    !shouldUpdate({ ...old, updatedAt: new Date(Date.now() - 19 * 3_600_000).toISOString() }, 40).update);

  console.log('');
  console.log('二、提示词的核心分寸：要感受，不要资料');
  console.log('─'.repeat(64));
  {
    const prompt = buildPortraitPrompt({
      persona: { name: '小满' },
      history: [
        { role: 'user', content: '今天加班到十点' },
        { role: 'assistant', content: '辛苦了' },
      ],
    });
    check('带上对话内容', prompt.includes('加班到十点'));
    check('明确要求写印象', /对这个人的印象/.test(prompt));
    check('★ 明确禁止罗列事实（否则和记忆重复）', /不要罗列事实/.test(prompt));
    check('★ 明确禁止空话', /不要空话/.test(prompt));
    check('允许不确定的词', /好像/.test(prompt));
    check('有长度限制', prompt.includes(String(MAX_LEN)));
    check('只输出正文', /只输出印象本身/.test(prompt));
  }
  {
    const withPrev = buildPortraitPrompt({
      persona: { name: '小满' },
      history: [{ role: 'user', content: '嗯' }],
      previous: { text: '他好像总在照顾别人的感受' },
    });
    check('★ 给了旧印象要求延续', /保留还成立的部分/.test(withPrev));
    check('明确说不要推倒重来', /推倒重来/.test(withPrev));
    check('旧印象内容被带入', withPrev.includes('总在照顾别人的感受'));
  }
  {
    const noPrev = buildPortraitPrompt({ persona: { name: '小满' }, history: [] });
    check('没有旧印象时不提延续', !/推倒重来/.test(noPrev));
    check('对话为空也不炸', noPrev.includes('还没有足够的对话'));
  }

  console.log('');
  console.log('三、清洗模型输出');
  console.log('─'.repeat(64));
  check('去掉"印象："前缀', cleanPortrait('印象：他话不多') === '他话不多');
  check('去掉引号', cleanPortrait('「他话不多」') === '他话不多');
  check('去掉双引号', cleanPortrait('"他话不多"') === '他话不多');
  check('多行合并成一行', cleanPortrait('他话不多\n但很实在') === '他话不多 但很实在');
  check('超长会截断', cleanPortrait('啊'.repeat(500)).length <= MAX_LEN + 1);
  check('空值返回空串', cleanPortrait(null) === '');

  console.log('');
  console.log('四、注入提示词的块');
  console.log('─'.repeat(64));
  check('有印象时生成块', portraitBlock({ text: '他话不多' }).includes('他话不多'));
  check('带【你眼里的他】标题', portraitBlock({ text: 'x' }).includes('【你眼里的他】'));
  check('★ 提醒不要直接念出来（念出来就穿帮了）',
    /不要直接念出来/.test(portraitBlock({ text: 'x' })));
  check('没印象时返回空串（不硬塞）', portraitBlock(null) === '');
  check('空文字也返回空串', portraitBlock({ text: '' }) === '');

  console.log('');
  console.log('五、落盘');
  console.log('─'.repeat(64));
  writePortrait({ text: '他是个嘴上说没事、其实会记很久的人', basedOn: 30, updatedAt: new Date().toISOString(), version: 1 });
  const back = readPortrait();
  check('写得进', back?.text === '他是个嘴上说没事、其实会记很久的人');
  check('读得回', back?.basedOn === 30);

  fs.writeFileSync(PORTRAIT_FILE, '{坏掉的 json');
  check('文件损坏时不炸，返回 null', readPortrait() === null);

  fs.writeFileSync(PORTRAIT_FILE, JSON.stringify({ text: '   ' }));
  check('空白内容视为没有印象', readPortrait() === null);
} finally {
  restore();
}

console.log('');
console.log('═'.repeat(64));
console.log(`通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
