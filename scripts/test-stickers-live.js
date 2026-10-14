// 表情包库的完整验证：不只是"文件在不在"，而是"她能不能真的挑出来发"。
import fs from 'node:fs';
import path from 'node:path';
import { listStickers, findSticker, readSticker, stickerStats, STICKER_DIR, STICKER_EXT } from '../src/soul/stickers.js';

let pass = 0, fail = 0;
const check = (n, c, extra = '') => {
  if (c) { console.log(`  ✓ ${n}`); pass++; }
  else { console.log(`  ✗ ${n} ${extra}`); fail++; }
};

console.log('一、库里有什么');
console.log('─'.repeat(64));
const all = listStickers();
const st = stickerStats();

// 别人刚拿到包时表情包目录是空的，这不算失败
if (!all.length) {
  console.log(`  目录: ${STICKER_DIR}`);
  console.log('  （空的 —— 还没下载表情包，跳过）');
  console.log('');
  console.log('  想装一批： node scripts/fetch-stickers.js');
  console.log('');
  process.exit(0);
}

console.log(`  目录: ${STICKER_DIR}`);
console.log(`  数量: ${st.count} 个，共 ${st.totalKB} KB`);
const byExt = {};
for (const s of all) byExt[s.ext] = (byExt[s.ext] || 0) + 1;
console.log(`  格式: ${Object.entries(byExt).map(([e, n]) => `${e}×${n}`).join('  ')}`);
check('库里有表情包', all.length > 0, `${all.length} 个`);
check('数量够用（≥40）', all.length >= 40, `${all.length}`);
check('全部文件真实存在且非空', all.every((s) => fs.existsSync(s.path) && s.size > 0));
check('没有重复名字', new Set(all.map((s) => s.name)).size === all.length);

console.log('');
console.log('二、★ 每个文件都要是**真图片**（不是 HTML 错误页换了个扩展名）');
console.log('─'.repeat(64));
{
  // 各种图片格式的魔数
  const MAGIC = [
    [0x89, 0x50, 0x4E, 0x47],             // PNG
    [0xFF, 0xD8, 0xFF],                   // JPEG
    [0x47, 0x49, 0x46, 0x38],             // GIF8
    [0x52, 0x49, 0x46, 0x46],             // RIFF (webp)
  ];
  const bad = [];
  for (const s of all) {
    const head = fs.readFileSync(s.path).subarray(0, 6);
    const ok = MAGIC.some((m) => m.every((b, i) => head[i] === b));
    if (!ok) bad.push(`${s.name}${s.ext} 头部=${[...head].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
  }
  check('★ 全部是真实图片魔数（0 个坏文件）', bad.length === 0, bad.slice(0, 5).join('; '));

  // 反向确认这条测试有牙齿：拿一个假文件试试
  const fake = path.join(STICKER_DIR, '__fake_test__.png');
  fs.writeFileSync(fake, '<!DOCTYPE html><html>404 Not Found</html>');
  const f = listStickers().find((s) => s.name === '__fake_test__');
  const head = f ? fs.readFileSync(f.path).subarray(0, 6) : Buffer.alloc(0);
  const detected = MAGIC.some((m) => m.every((b, i) => head[i] === b));
  check('（自检）假图片确实会被判出来', f && !detected);
  fs.rmSync(fake, { force: true });
}

console.log('');
console.log('三、她怎么"叫"这些表情包（这是关键：名字是模型自己写的）');
console.log('─'.repeat(64));
const cases = [
  ['晚安', '晚安'],
  ['哭哭', '哭哭'],
  ['震惊', '震惊'],
  ['摸摸头', '拍头'],          // 模型记错名字，模糊匹配要兜住
  ['比心', '比心'],
  ['哈哈哈哈', '哈哈哈哈'],
  ['在吗', '在吗'],
];
for (const [said, expect] of cases) {
  const got = findSticker(said);
  check(`她说「${said}」→ 找到「${got?.name}」`, got?.name === expect, `实际 ${got?.name}`);
}

console.log('');
console.log('四、模型记不清名字时不能崩，也不能乱发');
console.log('─'.repeat(64));
check('空名字 → 随机挑一个（她"就是想发个表情"）', !!findSticker(''), String(findSticker('')?.name));
check('完全不相关的名字 → 宁可返回 null 也不乱发', findSticker('量子力学论文答辩') === null,
  String(findSticker('量子力学论文答辩')?.name));
check('null 不崩', findSticker(null) !== undefined);
check('undefined 不崩', findSticker(undefined) !== undefined);

console.log('');
console.log('五、真的能把文件读出来发（走发送链路的那一步）');
console.log('─'.repeat(64));
{
  const spec = findSticker('委屈');
  const data = readSticker(spec);
  check('读到内容', !!data && data.data.length > 0, `${data?.data.length} 字节`);
  check('MIME 正确', ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(data?.mime), data?.mime);
  check('MIME 和扩展名对得上', (() => {
    const ext = path.extname(spec.path).toLowerCase();
    const want = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext];
    return data.mime === want;
  })());
  check('读出来的字节和磁盘一致', (() => {
    const onDisk = fs.readFileSync(spec.path);
    return Buffer.compare(onDisk, data.data) === 0;
  })());

  // 全库逐个读一遍，确保没有读不出来的
  const unreadable = all.filter((s) => !readSticker({ ...s, mime: 'image/png' }));
  check('★ 103 个全部读得出来', unreadable.length === 0, unreadable.map((s) => s.name).join(', '));
}

console.log('');
console.log('六、体积（太大微信那边会传很久甚至失败）');
console.log('─'.repeat(64));
{
  const big = all.filter((s) => s.size > 1024 * 1024);
  const biggest = all.reduce((a, b) => (a.size > b.size ? a : b));
  console.log(`  最大: ${biggest.name} ${Math.round(biggest.size / 1024)}KB`);
  check('没有超过 1MB 的', big.length === 0, big.map((s) => `${s.name} ${Math.round(s.size / 1024)}KB`).join(', '));
  check('总量在合理范围（<40MB）', st.totalKB < 40 * 1024, `${st.totalKB}KB`);
}

console.log('');
console.log('七、文件名要干净（她会照着念）');
console.log('─'.repeat(64));
{
  const weird = all.filter((s) => /[\r\n\t]/.test(s.name) || s.name.length > 20 || s.name.includes('/'));
  check('没有换行/超长/带斜杠的名字', weird.length === 0, weird.map((s) => s.name).join(', '));
  const noName = all.filter((s) => !s.name.trim());
  check('没有无名表情包', noName.length === 0);
}

console.log('');
console.log('═'.repeat(64));
console.log(`通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
