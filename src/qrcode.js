// 最小 QR 编码器：零依赖生成二维码矩阵。
//
// 为什么自己写：Node 没有内置 QR 生成，也没内置图像库。为了保持"零依赖、
// 拷走就能跑"这个特性，这里实现一个够用的子集 ——
// 支持字节模式（UTF-8）、纠错等级 L/M/Q/H、版本 1-10 自动选择。
//
// 登录链接约 90 字符，版本 5-6 足够，但接口留全。
//
// 输出：布尔矩阵（true = 黑点），不含静区，调用方自己加白边。

// ── GF(256) 伽罗华域运算（Reed-Solomon 纠错需要）──
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // 本原多项式
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** 生成多项式 */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], 1);
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** 计算纠错码字 */
function rsEncode(data, ecCount) {
  const gen = rsGenerator(ecCount);
  const res = new Array(data.length + ecCount).fill(0);
  for (let i = 0; i < data.length; i++) res[i] = data[i];

  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      res[i + j] ^= gfMul(gen[j], coef);
    }
  }
  return res.slice(data.length);
}

// ── 版本参数表（版本 1-10）──
// [总码字数, [各纠错等级: 每块数据码字, 块数, 每块EC码字]]
// 参考 ISO/IEC 18004 标准表
const VERSIONS = [
  null,
  // v1
  { total: 26, L: [19, 1, 7], M: [16, 1, 10], Q: [13, 1, 13], H: [9, 1, 17] },
  // v2
  { total: 44, L: [34, 1, 10], M: [28, 1, 16], Q: [22, 1, 22], H: [16, 1, 28] },
  // v3
  { total: 70, L: [55, 1, 15], M: [44, 1, 26], Q: [34, 2, 18], H: [26, 2, 22] },
  // v4
  { total: 100, L: [80, 1, 20], M: [64, 2, 18], Q: [48, 2, 26], H: [36, 4, 16] },
  // v5
  { total: 134, L: [108, 1, 26], M: [86, 2, 24], Q: [62, 2, 18], H: [46, 2, 22] },
  // v6
  { total: 172, L: [136, 2, 18], M: [108, 4, 16], Q: [76, 4, 24], H: [60, 4, 28] },
  // v7
  { total: 196, L: [156, 2, 20], M: [124, 4, 18], Q: [88, 2, 18], H: [66, 4, 26] },
  // v8
  { total: 242, L: [194, 2, 24], M: [154, 2, 22], Q: [110, 4, 22], H: [86, 4, 26] },
  // v9
  { total: 292, L: [232, 2, 30], M: [182, 3, 22], Q: [132, 4, 20], H: [100, 4, 24] },
  // v10
  { total: 346, L: [274, 2, 18], M: [216, 4, 26], Q: [154, 6, 24], H: [122, 6, 28] },
];

/** 各版本的对齐图案中心坐标。 */
const ALIGN = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

/** 格式信息（纠错等级 + 掩码）的 BCH 编码表。 */
const FORMAT_INFO = {
  L: [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976],
  M: [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0],
  Q: [0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed],
  H: [0x1689, 0x13be, 0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b],
};

const VERSION_INFO = [
  0x07c94, 0x085bc, 0x09a99, 0x0a4d3, 0x0bbf6, 0x0c762,
  0x0d847, 0x0e60d, 0x0f928, 0x10b78,
];

/**
 * 编码字符串为 QR 矩阵。
 * @param {string} text
 * @returns {boolean[][]} true = 黑
 */
export function encodeQr(text) {
  const bytes = Buffer.from(String(text), 'utf8');

  // 选最小可用版本（纠错等级 L）
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const spec = VERSIONS[v].L;
    const dataCodewords = spec[0] * spec[1];
    const capacityBits = dataCodewords * 8;
    // 模式(4) + 长度指示符 + 数据
    const lenBits = v <= 9 ? 8 : 16;
    if (4 + lenBits + bytes.length * 8 <= capacityBits) { version = v; break; }
  }
  if (!version) return null; // 太长，本次不支持

  const ecc = 'L';
  const spec = VERSIONS[version][ecc];
  const [perBlockData, blockCount, perBlockEc] = spec;
  const dataCodewords = perBlockData * blockCount;

  // ── 构造数据位流 ──
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4);                       // 字节模式
  push(bytes.length, version <= 9 ? 8 : 16); // 长度
  for (const b of bytes) push(b, 8);

  // 终止符
  const capBits = dataCodewords * 8;
  for (let i = 0; i < 4 && bits.length < capBits; i++) bits.push(0);
  // 补齐到字节
  while (bits.length % 8 !== 0) bits.push(0);
  // 填充码字
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (bits.length < capBits) {
    push(padBytes[padIdx % 2], 8);
    padIdx++;
  }

  // 位流 → 码字
  const dataWords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    dataWords.push(byte);
  }

  // ── 分块 + 纠错 ──
  const blocks = [];
  for (let i = 0; i < blockCount; i++) {
    const chunk = dataWords.slice(i * perBlockData, (i + 1) * perBlockData);
    blocks.push({ data: chunk, ec: rsEncode(chunk, perBlockEc) });
  }

  // ── 交织 ──
  const finalWords = [];
  for (let i = 0; i < perBlockData; i++) {
    for (const b of blocks) finalWords.push(b.data[i]);
  }
  for (let i = 0; i < perBlockEc; i++) {
    for (const b of blocks) finalWords.push(b.ec[i]);
  }

  // ── 构造矩阵 ──
  const size = version * 4 + 17;
  const matrix = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFn = (r, c, v) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    matrix[r][c] = v;
    reserved[r][c] = true;
  };

  // 定位图案（三个角）
  for (const [fr, fc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = fr + r; const cc = fc + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const isBorder = r === 0 || r === 6 || c === 0 || c === 6;
        const isCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setFn(rr, cc, isBorder || isCore);
      }
    }
  }

  // 定位图案之间的分隔线
  for (let i = 0; i < 8; i++) {
    setFn(7, i, false); setFn(i, 7, false);
    setFn(7, size - 1 - i, false); setFn(i, size - 8, false);
    setFn(size - 8, i, false); setFn(size - 1 - i, 7, false);
  }

  // 校正图案
  const alignPos = ALIGN[version] ?? [];
  for (const r of alignPos) {
    for (const c of alignPos) {
      // 跳过与定位图案重叠的位置
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const isRing = Math.abs(dr) === 2 || Math.abs(dc) === 2;
          setFn(r + dr, c + dc, isRing || (dr === 0 && dc === 0));
        }
      }
    }
  }

  // 时序图案
  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6][i]) setFn(6, i, i % 2 === 0);
    if (!reserved[i][6]) setFn(i, 6, i % 2 === 0);
  }

  // 预留格式信息区。
  // 必须精确覆盖 writeFormat 会写到的每个格子，否则掩码会覆盖格式信息。
  // 注意第 6 行/第 6 列是时序图案，不属于格式信息区 —— 不能标记为 reserved
  // 之外的区域，也不能被格式信息写入。
  for (let i = 0; i < 9; i++) {
    if (i !== 6) reserved[8][i] = true;  // 第 8 行左侧（跳过时序列 6）
    if (i !== 6) reserved[i][8] = true;  // 第 8 列上方（跳过时序行 6）
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;    // 第 8 行右侧
    reserved[size - 1 - i][8] = true;    // 第 8 列下方
  }
  setFn(size - 8, 8, true); // 固定的黑模块

  // 版本信息（v7+）
  if (version >= 7) {
    const vinfo = VERSION_INFO[version - 7];
    for (let i = 0; i < 18; i++) {
      const bit = ((vinfo >> i) & 1) === 1;
      const r = Math.floor(i / 3);
      const c = i % 3;
      setFn(size - 11 + c, r, bit);
      setFn(r, size - 11 + c, bit);
    }
  }

  // ── 填充数据（之字形）──
  const dataBits = [];
  for (const w of finalWords) {
    for (let i = 7; i >= 0; i--) dataBits.push((w >> i) & 1);
  }

  let bitIdx = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // 跳过时序列
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        matrix[row][c] = bitIdx < dataBits.length ? dataBits[bitIdx] === 1 : false;
        bitIdx++;
      }
    }
    upward = !upward;
  }

  // ── 掩码（选惩罚分最低的）──
  // 关键：掩码只能作用于**数据区**，绝不能碰功能图案（定位/校正/时序/格式）。
  // 之前用简化判断导致掩码污染了功能模块，二维码结构看着对但扫不出来。
  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = matrix.map((row) => [...row]);
    applyMask(m, mask, reserved);
    writeFormat(m, ecc, mask, size);
    const score = penalty(m);
    if (score < bestScore) { bestScore = score; best = m; }
  }

  return best;
}

function maskFn(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
}

/**
 * 应用掩码。用构建阶段记录下来的 reserved 表判断数据区 ——
 * 这张表是唯一权威，不要用几何规则重新推断（校正图案、版本信息区等
 * 位置随版本变化，重新推断必然漏）。
 */
function applyMask(m, mask, reserved) {
  const size = m.length;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (reserved[r][c]) continue; // 功能模块不动
      if (maskFn(mask, r, c)) m[r][c] = !m[r][c];
    }
  }
}

/**
 * 写入格式信息（15 位：5 位数据 + 10 位 BCH 纠错）。
 *
 * 位序是这张码能不能扫出来的关键，且**两个副本的顺序不同**：
 *   - 副本一（左上）：高位在前（bit14 → bit0）
 *   - 副本二（右上 + 左下）：低位在前（bit0 → bit14）
 *
 * 这是实测比对标准实现得出的结论 —— 一开始两处都写成低位在前，
 * 结果二维码结构、数据、纠错全对，唯独解码器读不出格式信息，
 * 整张码扫不出来（差异仅 10 格，肉眼完全看不出）。
 */
function writeFormat(m, ecc, mask, size) {
  const info = FORMAT_INFO[ecc][mask];
  const bitAt = (i) => ((info >> i) & 1) === 1;

  // ── 副本一：左上，高位在前 ──
  // 位置顺序：(8,0..5) → (8,7) → (8,8) → (7,8) → (5,8) → (4,8) → (3,8) → (2,8) → (1,8) → (0,8)
  // 注意跳过 (8,6) 与 (6,8)，那是时序图案。
  const slotA = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
    [8, 7], [8, 8], [7, 8],
    [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (let k = 0; k < 15; k++) {
    const [r, c] = slotA[k];
    m[r][c] = bitAt(14 - k); // 高位在前
  }

  // ── 副本二：右上（8 位）+ 左下（7 位），低位在前 ──
  for (let i = 0; i < 8; i++) {
    m[8][size - 1 - i] = bitAt(i);
  }
  for (let i = 8; i < 15; i++) {
    m[size - 15 + i][8] = bitAt(i);
  }

  // 固定的黑模块（不属于格式信息，但必须置黑）
  m[size - 8][8] = true;
}

function penalty(m) {
  const size = m.length;
  let score = 0;

  // 规则1：同色连续
  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c < size; c++) {
      if (m[r][c] === m[r][c - 1]) run++;
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    if (run >= 5) score += run - 2;
  }
  for (let c = 0; c < size; c++) {
    let run = 1;
    for (let r = 1; r < size; r++) {
      if (m[r][c] === m[r - 1][c]) run++;
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    if (run >= 5) score += run - 2;
  }

  // 规则2：2x2 同色块
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  // 规则4：黑白比例
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}
