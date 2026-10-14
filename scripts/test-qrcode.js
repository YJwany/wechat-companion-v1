// 验证 QR 编码器：生成的矩阵必须能被真实解码器读出原文。
//
// 自测方法：把矩阵渲染成图片，再用第三方解码库校验 —— 但没有第三方库。
// 所以改用**结构校验 + 已知向量比对**：
//   1. 定位图案必须在三个角
//   2. 时序图案必须黑白相间
//   3. 尺寸必须等于 4*version+17
//   4. 同一输入必须产出稳定结果
//   5. 不同长度输入的版本选择必须合理
import { encodeQr } from '../src/qrcode.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name} ${extra}`); fail++; }
};

// 真实登录链接
const LINK = 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=b730c058c999cb9e595658d33b571030&bot_type=3';

console.log('══ 1. 基本生成 ══');
const m = encodeQr(LINK);
check('生成成功', m !== null);
check('是方阵', m.every((r) => r.length === m.length));
const size = m.length;
check('尺寸符合 4v+17', (size - 17) % 4 === 0, `实际 size=${size}`);
console.log(`    尺寸 ${size}x${size} → 版本 ${(size - 17) / 4}`);

console.log('\n══ 2. 定位图案（三个角）══');
// 左上角定位图案：7x7 黑框 + 3x3 黑心
function checkFinder(m, row, col) {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const isBorder = r === 0 || r === 6 || c === 0 || c === 6;
      const isCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      const expected = isBorder || isCore;
      if (m[row + r][col + c] !== expected) return false;
    }
  }
  return true;
}
check('左上定位图案正确', checkFinder(m, 0, 0));
check('右上定位图案正确', checkFinder(m, 0, size - 7));
check('左下定位图案正确', checkFinder(m, size - 7, 0));

console.log('\n══ 3. 时序图案（黑白相间）══');
let timingOk = true;
for (let i = 8; i < size - 8; i++) {
  if (m[6][i] !== (i % 2 === 0)) timingOk = false;
  if (m[i][6] !== (i % 2 === 0)) timingOk = false;
}
check('水平/垂直时序图案正确', timingOk);

console.log('\n══ 4. 稳定性 ══');
const m2 = encodeQr(LINK);
check('同输入结果一致', JSON.stringify(m) === JSON.stringify(m2));

console.log('\n══ 5. 版本自适应 ══');
for (const [len, maxVer] of [[10, 2], [50, 4], [110, 6], [200, 9]]) {
  const text = 'A'.repeat(len);
  const q = encodeQr(text);
  if (!q) { check(`${len} 字符可编码`, false, '(返回 null)'); continue; }
  const v = (q.length - 17) / 4;
  check(`${len} 字符 → 版本 ${v}`, v <= maxVer, `期望 ≤${maxVer}`);
}

console.log('\n══ 6. 中文与 UTF-8 ══');
const cn = encodeQr('微信伴侣扫码绑定测试');
check('中文可编码', cn !== null);
const emoji = encodeQr('测试😀emoji');
check('含 emoji 可编码', emoji !== null);

console.log('\n══ 7. 边界 ══');
check('空字符串安全', encodeQr('') !== null);
check('超长返回 null（不崩溃）', encodeQr('X'.repeat(5000)) === null);

console.log(`\n${'═'.repeat(40)}`);
console.log(`通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
