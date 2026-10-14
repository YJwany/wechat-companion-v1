// 表情包库的**接口契约**测试：不管库里有哪些图，这些性质都必须成立。
//
// 刻意不写死任何具体名字 —— 早先这版把"晚安猫/笑死/摸鱼/好的"写死了，
// 后来换成真实表情包，测试全红，但代码其实一点问题都没有。
// 测试应该盯着"行为"，不是盯着"当下有哪些文件"。
import fs from 'node:fs';
import path from 'node:path';
import {
  listStickers, findSticker, readSticker, stickerStats, hasStickers,
  nameSimilarity, STICKER_DIR, STICKER_EXT, STICKER_ALIAS,
} from '../src/soul/stickers.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name} ${extra}`); fail++; }
};

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

const all = listStickers();
console.log('表情包库（接口契约）');
console.log('═'.repeat(64));
console.log(`目录: ${STICKER_DIR}`);
console.log(`数量: ${all.length}`);

if (!all.length) {
  // 别人刚拿到包时是空的 —— 空库也必须不崩
  console.log('');
  console.log('库是空的，只测"空库不崩"（这是全新安装的正常状态）');
  check('空库时 list 返回空数组', Array.isArray(all) && all.length === 0);
  check('空库时 hasStickers 为 false', hasStickers() === false);
  check('空库时 findSticker 返回 null', findSticker('随便什么') === null);
  check('空库时统计不崩', stickerStats().count === 0);
  console.log('');
  console.log('想装一批： node scripts/fetch-stickers.js');
  console.log('═'.repeat(64));
  console.log(`通过 ${pass} / ${pass + fail}`);
  process.exit(fail ? 1 : 0);
}

console.log('');
console.log('一、列出来的东西必须自洽');
console.log('─'.repeat(64));
const stats = stickerStats();
check('hasStickers 和 list 一致', hasStickers() === (all.length > 0));
check('stats.count 等于 list 长度', stats.count === all.length, `${stats.count} vs ${all.length}`);
check('stats.names 和 list 一一对应',
  JSON.stringify(stats.names) === JSON.stringify(all.map((s) => s.name)));
check('每个都能拿到绝对路径且文件存在',
  all.every((s) => path.isAbsolute(s.path) && fs.existsSync(s.path)));
check('每个文件都非空', all.every((s) => s.size > 0));
check('size 和磁盘上一致',
  all.every((s) => fs.statSync(s.path).size === s.size));
check('没有重名', new Set(all.map((s) => s.name)).size === all.length);
check('扩展名都在白名单里', all.every((s) => STICKER_EXT.includes(s.ext)));
check('名字 = 去掉扩展名的文件名',
  all.every((s) => s.name === path.basename(s.file, path.extname(s.file))));

console.log('');
console.log('二、精确匹配必须永远赢');
console.log('─'.repeat(64));
{
  // 这条挡的是"库里同时有「晚安」和「晚安我睡了」，说晚安却命中后者"
  const wrong = all.filter((s) => findSticker(s.name)?.name !== s.name);
  check('★ 每个名字说出口都命中它自己', wrong.length === 0,
    wrong.slice(0, 5).map((s) => `${s.name}→${findSticker(s.name)?.name}`).join(', '));

  // 前后空格不影响
  const padded = all[0].name;
  check('首尾空格不影响', findSticker(`  ${padded}  `)?.name === padded);
  // 中间空格会被去掉
  check('名字里插空格也能命中', findSticker(padded.split('').join(' '))?.name === padded);
}

console.log('');
console.log('三、mime 要和扩展名对得上（发错类型微信那边会失败）');
console.log('─'.repeat(64));
{
  // listStickers() 只给文件信息；mime 是 findSticker() 补上的
  const bad = all.filter((s) => findSticker(s.name)?.mime !== MIME_BY_EXT[s.ext]);
  check('★ 全部 mime 正确', bad.length === 0,
    bad.slice(0, 5).map((s) => `${s.name}${s.ext}→${findSticker(s.name)?.mime}`).join(', '));
}

console.log('');
console.log('四、读出来的字节必须和磁盘一模一样');
console.log('─'.repeat(64));
{
  const bad = [];
  for (const s of all) {
    const got = readSticker(s);
    if (!got) { bad.push(`${s.name} 读不出`); continue; }
    if (Buffer.compare(got.data, fs.readFileSync(s.path)) !== 0) bad.push(`${s.name} 内容不一致`);
  }
  check(`★ ${all.length} 个全部原样读出`, bad.length === 0, bad.slice(0, 5).join(', '));
  check('readSticker(null) 返回 null', readSticker(null) === null);
  check('readSticker({}) 返回 null', readSticker({}) === null);
  check('文件不存在时返回 null 而不是崩',
    readSticker({ path: path.join(STICKER_DIR, '__不存在__.png'), mime: 'image/png' }) === null);
}

console.log('');
console.log('五、模糊查找的边界');
console.log('─'.repeat(64));
check('空名字 → 随机挑一个', !!findSticker(''));
check('null → 随机挑一个（不崩）', !!findSticker(null));
check('undefined → 随机挑一个（不崩）', !!findSticker(undefined));
check('完全不沾边 → null，不硬发', findSticker('量子力学论文答辩流程zzz') === null,
  String(findSticker('量子力学论文答辩流程zzz')?.name));
check('纯符号 → 不至于崩', findSticker('!!!???') === null || !!findSticker('!!!???'));

console.log('');
console.log('六、同义词表不能指向不存在的图');
console.log('─'.repeat(64));
{
  const names = new Set(all.map((s) => s.name));
  const dead = Object.entries(STICKER_ALIAS).filter(([, to]) => !names.has(to));
  check('★ 同义词目标全部存在（写错一个字就静默失效）', dead.length === 0,
    dead.map(([k, v]) => `${k}→${v}`).join(', '));

  const broken = Object.entries(STICKER_ALIAS).filter(([said, to]) => findSticker(said)?.name !== to);
  check('★ 每条同义词都能真的找到目标', broken.length === 0,
    broken.map(([k, v]) => `${k}→ 实际 ${findSticker(k)?.name}`).join(', '));
}

console.log('');
console.log('七、相似度函数本身');
console.log('─'.repeat(64));
{
  check('完全一样 → 1', nameSimilarity('哭哭', '哭哭') === 1);
  check('毫不相干 → 0', nameSimilarity('量子力学', '哭哭') === 0);
  check('空串 → 0', nameSimilarity('', '哭哭') === 0 && nameSimilarity('哭哭', '') === 0);
  // 叠字不能因为重复而多加分
  check('★ 叠字不重复加分',
    nameSimilarity('摸摸头', '摸鱼') === nameSimilarity('摸头', '摸鱼'),
    `${nameSimilarity('摸摸头', '摸鱼')} vs ${nameSimilarity('摸头', '摸鱼')}`);
  // 长度差太多要罚
  check('★ 长度差太多要罚（否则长句会命中短名字）',
    nameSimilarity('绝对不存在的名字zzz', '对不起') < 0.5,
    String(nameSimilarity('绝对不存在的名字zzz', '对不起')));
}

console.log('');
console.log('═'.repeat(64));
console.log(`通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
