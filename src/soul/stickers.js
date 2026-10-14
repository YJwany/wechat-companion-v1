// 表情包库：她在聊天里能自己挑一个发出去。
//
// 设计取舍（对照参考实现后定的）：
//   - **文件名就是名字**。不用单独维护索引 JSON —— 少一个会失同步的状态。
//     往 data/stickers/ 丢一张「晚安猫.png」，她就有了一个叫"晚安猫"的表情包。
//   - **模糊匹配**：模型不一定记得准名字，她可能说"晚安猫咪"而库里叫"晚安猫"。
//     宁可发个相近的，也别让她"想发表情包却发不出去"。
//   - 复用已验证的图片发送链路（CDN 加密上传那套），不新写发送代码。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

export const STICKER_DIR = path.join(DATA_DIR, 'stickers');

/** 能当表情包用的图片格式。 */
export const STICKER_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** 扩展名 → 该有的魔数。用来查"文件内容和后缀名对不上"。 */
const MAGIC = [
  ['image/jpeg', '.jpg', [0xFF, 0xD8, 0xFF]],
  ['image/png', '.png', [0x89, 0x50, 0x4E, 0x47]],
  ['image/gif', '.gif', [0x47, 0x49, 0x46, 0x38]],    // "GIF8"
  ['image/webp', '.webp', [0x52, 0x49, 0x46, 0x46]],  // RIFF（够用了）
];

/**
 * 看文件头判断**真实**类型。
 *
 * 为什么不能信扩展名：真踩到过 —— 从表情包仓库下来的「不许凶我.gif」
 * 其实是个 JPEG。微信按 mime 处理，标错了要么发失败、要么发出去是个坏图。
 * 所以这里一律以文件内容为准。
 *
 * @returns {{mime: string, ext: string}|null} 认不出来就 null
 */
export function sniffImage(buf) {
  if (!buf || buf.length < 4) return null;
  for (const [mime, ext, sig] of MAGIC) {
    if (sig.every((b, i) => buf[i] === b)) return { mime, ext };
  }
  return null;
}

/** 只读文件头判断类型，不把整个文件读进内存。 */
function sniffFile(full) {
  let fd = null;
  try {
    fd = fs.openSync(full, 'r');
    const head = Buffer.alloc(16);
    const n = fs.readSync(fd, head, 0, 16, 0);
    return sniffImage(head.subarray(0, n));
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* */ } }
  }
}

export function ensureStickerDir() {
  fs.mkdirSync(STICKER_DIR, { recursive: true });
}

/**
 * 列出所有表情包。名字 = 去掉扩展名的文件名。
 *
 * `ext` 是**文件内容**的真实类型，不是文件名后缀 ——
 * 两者不一致时以内容为准（上游真发生过「xxx.gif」其实是 JPEG）。
 * `mismatch` 标记出这种文件，方便后台提示你去改名。
 *
 * @returns {Array<{name, file, path, size, ext, mime, mismatch}>}
 */
export function listStickers() {
  try {
    if (!fs.existsSync(STICKER_DIR)) return [];
    return fs.readdirSync(STICKER_DIR)
      .filter((f) => STICKER_EXT.includes(path.extname(f).toLowerCase()))
      .map((f) => {
        const full = path.join(STICKER_DIR, f);
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* 文件可能刚好被删了 */ }
        const onDiskExt = path.extname(f).toLowerCase();
        const sniffed = sniffFile(full);
        // 认不出来就退回按后缀名处理（可能是个我们没见过的格式，但总比整库挂掉好）
        const ext = sniffed?.ext ?? onDiskExt;
        return {
          name: path.basename(f, path.extname(f)),
          file: f,
          path: full,
          size,
          ext,
          mime: sniffed?.mime ?? MIME[onDiskExt] ?? 'image/png',
          // 后缀名和真实内容不一致 —— 不影响发送（我们用 mime），但值得提示
          mismatch: !!sniffed && sniffed.ext !== onDiskExt
            && !(onDiskExt === '.jpeg' && sniffed.ext === '.jpg'),
        };
      })
      .filter((s) => s.size > 0)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  } catch {
    return [];
  }
}

/** 有没有表情包可用。 */
export function hasStickers() {
  return listStickers().length > 0;
}

/**
 * 她"想说的"和库里"实际叫的"对不上时用的同义词表。
 *
 * 为什么需要它：光靠字重合度救不了这种情况 ——
 * 「摸摸头」想找的显然是「拍头」，但字面上它和「摸鱼」重了一个"摸"字，
 * 两者得分一模一样，机器没法知道哪个对。真人一眼就知道，因为**懂意思**。
 * 所以这种就老老实实写下来，比调阈值靠谱。
 */
export const STICKER_ALIAS = {
  摸摸头: '拍头', 摸头: '拍头', 摸头杀: '拍头',
  抱抱: '要亲亲要抱抱', 抱一下: '要亲亲要抱抱', 求抱抱: '需要一个抱抱',
  亲亲: '亲亲害羞', 亲一口: '要亲你',
  想你: '有一点点想你', 想你了: '有一点点想你',
  爱你: '就是喜欢你', 喜欢你: '就是喜欢你',
  睡觉: '晚安', 睡了: '晚安', 困了: '困了哈欠', 晚安啦: '晚安',
  早安: '早上好', 起床: '不想起床',
  生气: '我在生气', 气了: '我在生气', 不开心: '我不开心了',
  哭: '哭哭', 难过: '委屈', 伤心: '哭哭',
  开心: '开心', 高兴: '开心', 笑死: '哈哈哈哈', 哈哈: '哈哈哈哈',
  谢谢: '谢谢老板', 感谢: '谢谢老板',
  无语: '问号', 吃惊: '震惊', 惊讶: '震惊',
  累了: '我好累', 好累啊: '我好累',
  搞笑: '已深度思考', 沙雕: '已深度思考',
  在干嘛呢: '在干嘛', 在吗在吗: '在吗',
  对不起嘛: '对不起', 我错了: '我错啦别凶我',
  好的: '客气了', 收到: '收到办不到',
  歪头: '歪头看你', 害羞了: '害羞',
};

/**
 * 两个名字的相似度（0~1）。独立出来是为了能直接测，不用先在磁盘上摆一堆图。
 *
 * **必须对查询串去重**。以前的写法直接遍历原字符串，"摸摸头"里的两个"摸"
 * 会各记一次分，于是一个"摸"字就骗到了 0.67，把"摸鱼"当成了"摸摸头"。
 * 真事：她说「摸摸头」，发出去的是「摸鱼」。
 */
export function nameSimilarity(wanted, candidate) {
  const wq = new Set(String(wanted ?? '').replace(/\s+/g, ''));
  const a = new Set(String(candidate ?? '').replace(/\s+/g, ''));
  if (!wq.size || !a.size) return 0;
  let hit = 0;
  for (const ch of wq) if (a.has(ch)) hit++;
  // 分母取**较长**的一边。
  // 曾经改成取较短的一边（想让它更宽容），结果「绝对不存在的名字zzz」和
  // 「对不起」重了"不""对"两个字，得分 2/3 = 0.67，直接命中了 —— 全是误报。
  // 取长边会惩罚"长度差太多"，这才是我们要的。
  return hit / Math.max(wq.size, a.size);
}

/**
 * 按名字找表情包。顺序：同义词 → 精确 → 包含 → 字重合度。
 *
 * @returns {{name, path, ext, mime, size}|null}
 */
export function findSticker(wanted) {
  const w = String(wanted ?? '').replace(/\s+/g, '').trim();
  const all = listStickers();
  if (!all.length) return null;

  // mime 用 listStickers 已经按文件内容探好的，不再按后缀名猜
  const wrap = (s) => ({ name: s.name, path: s.path, ext: s.ext, mime: s.mime, size: s.size, mismatch: s.mismatch });
  const exactName = (n) => all.find((s) => s.name === n);

  // 没给名字 → 随机挑一个（她可能就是"想发个表情包"）
  if (!w) return wrap(all[Math.floor(Math.random() * all.length)]);

  const exact = exactName(w);
  if (exact) return wrap(exact);

  // 同义词
  const alias = STICKER_ALIAS[w];
  if (alias) {
    const hit = exactName(alias);
    if (hit) return wrap(hit);
  }

  // 包含关系（双向）
  const contains = all.find((s) => s.name.includes(w) || w.includes(s.name));
  if (contains) return wrap(contains);

  // 退一步：字重合度。宁可发个相近的，也别让她发不出去 —— 但也不能乱发。
  //
  // 阈值是**严格大于** 0.5。因为 0.5 是个说不清的分数：
  // 「摸摸头」对「拍头」是 0.5，对「摸鱼」也是 0.5 —— 机器分不出哪个对，
  // 只能靠 STICKER_ALIAS 里写死。所以平局宁可返回 null（她就没发这个表情），
  // 也别赌一把发错图。发错表情比不发难看得多。
  let best = null;
  let bestScore = 0;
  for (const s of all) {
    const score = nameSimilarity(w, s.name);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return bestScore > 0.5 ? wrap(best) : null;
}

/** 读表情包内容（发送时用）。 */
export function readSticker(spec) {
  if (!spec?.path) return null;
  try {
    const data = fs.readFileSync(spec.path);
    if (!data.length) return null;
    // mime 以**真正要发出去的那串字节**为准，不信文件名也不信缓存的 spec。
    // 上游有文件后缀名和内容不符的情况（「不许凶我.gif」其实是 JPEG）。
    const sniffed = sniffImage(data);
    return {
      data,
      mime: sniffed?.mime ?? spec.mime ?? 'image/png',
      name: spec.name,
    };
  } catch {
    return null;
  }
}

/** 后台展示用。 */
export function stickerStats() {
  const all = listStickers();
  return {
    count: all.length,
    dir: STICKER_DIR,
    names: all.map((s) => s.name),
    totalKB: Math.round(all.reduce((n, s) => n + s.size, 0) / 1024),
    animated: all.filter((s) => s.ext === '.gif').length,
    // 后缀名和真实内容对不上的（不影响发送，但你可能想改名）
    mismatched: all.filter((s) => s.mismatch).map((s) => s.file),
  };
}
