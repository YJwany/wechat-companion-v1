// 从开源表情包仓库 ChineseBQB 拉一批表情包到 data/stickers/。
//
// 用法：
//   node scripts/fetch-stickers.js              # 只拉清单里还没有的
//   node scripts/fetch-stickers.js --force      # 全部重下
//   node scripts/fetch-stickers.js --list       # 只列清单，不下载
//
// ── 为什么是"清单"而不是"全下" ──
// 仓库里有 6000 多张，绝大多数不适合她发：有骂人的（"崽种猫"）、有暴力的
// （"我一脚丫子踹死你"）、有擦边的、有政治的。她是拿去跟人聊天的，
// 这些发出去当场就崩人设。所以这里是一份**人工挑过的白名单**，
// 每条都写清楚选它的理由。
//
// ── 关于授权 ──
// 这个仓库没有声明许可证，里面的图是网络流行的表情包，版权属于各自的作者。
// 所以：**自己用没问题，别随包分发**。好在程序本身已经处理了这件事 ——
// data/ 同时被 .gitignore 和 pack.js 排除，打包给别人时表情包不会跟着走。
//
// ── 零依赖 ──
// 只用 Node 内置模块。git 只用来拿目录树（也可以手动指定已克隆的路径）。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { STICKER_DIR, STICKER_EXT, ensureStickerDir, sniffImage } from '../src/soul/stickers.js';

const REPO_SLUG = 'zhaoolee/ChineseBQB';
const BRANCH = 'master';
// 实测（国内）：jsDelivr 约 52 KB/s，raw 约 34 KB/s，ghproxy 约 19 KB/s。
// 所以 jsDelivr 优先，失败再回落到官方 raw。
const MIRRORS = [
  (p) => `https://cdn.jsdelivr.net/gh/${REPO_SLUG}@${BRANCH}/${p}`,
  (p) => `https://raw.githubusercontent.com/${REPO_SLUG}/${BRANCH}/${p}`,
];

// ── 分类目录名（仓库里就是中文的，直接用）──
const CAT = {
  cat: '010Cat_是喵星人啦🐱BQB',
  girl: '002CuteGirl_可爱的女孩纸👧BQB',
  duck: '008HappyDuck_开心鸭🐥BQB',
  bear: '009KumamotoBear_熊本熊🐻BQB',
  mur: '060MurCat_Mur猫😺BQB',
  opossum: '109_Opossum_负鼠_BQB',
  hamster: '006Hamster_仓鼠🐹BQB',
};

// ── 白名单：[分类, 原文件名里的关键词, 她的名字] ──
// 名字就是她在聊天里"叫"这个名字，所以必须短、口语、一眼知道是什么情绪。
const PICKS = [
  // ── 撒娇 / 亲密 ──
  ['girl', '我要亲你', '要亲你'],
  ['girl', '亲亲-害羞', '亲亲害羞'],
  ['girl', '要亲亲要抱抱', '要亲亲要抱抱'],
  ['girl', '等一个亲亲', '等一个亲亲'],
  ['girl', '么么哒', '么么哒'],
  ['girl', '花式比心', '比心'],
  ['girl', '爱心发射', '爱心发射'],
  ['girl', '我有一点点想你', '有一点点想你'],
  ['girl', '汇报一下今天我也喜欢你哦', '今天也喜欢你'],
  ['girl', '我就是喜欢你阿', '就是喜欢你'],
  ['girl', '你是不是喜欢我', '你是不是喜欢我'],
  ['girl', '你的小可爱已上线', '你的小可爱上线了'],
  ['girl', '一位小可爱走过', '小可爱路过'],
  ['girl', '需要一个抱抱', '需要一个抱抱'],
  ['bear', '么么哒-辛苦啦', '么么哒辛苦啦'],
  ['bear', '晚上好', '晚上好'],
  ['bear', '虽然很不想说', '不想说但晚安'],

  // ── 开心 ──
  ['duck', '今天也要开心鸭', '今天也要开心'],
  ['girl', '耶耶嘿嘿', '嘿嘿'],
  ['girl', '开心笑-亲亲', '开心'],
  ['cat', '美滋滋猫', '美滋滋'],
  ['bear', '嚯哈哈哈', '哈哈哈哈'],
  ['cat', '歪头笑眯眯猫', '笑眯眯'],

  // ── 难过 / 委屈 / 累 ──
  ['girl', '哭哭', '哭哭'],
  ['girl', '委屈巴巴', '委屈巴巴'],
  ['girl', '委屈', '委屈'],
  ['girl', '我不开心了', '我不开心了'],
  ['girl', '我好累', '我好累'],
  ['girl', '当仙女好累', '好累哦'],
  ['cat', '我累了猫', '我累了'],
  ['cat', '惆怅猫', '惆怅'],
  ['cat', '我想不通猫', '想不通'],
  ['cat', '愁猫', '发愁'],
  ['cat', '我的悲伤打个有这么大猫', '我的悲伤有这么大'],
  ['cat', '擦眼泪猫', '擦眼泪'],
  ['cat', '捂住嘴巴不让自己哭出声猫', '忍住不哭'],

  // ── 生气 / 傲娇 ──
  ['girl', '哼', '哼'],
  ['cat', '我在生气莫挨老子猫', '我在生气'],
  ['cat', '我要闹了猫', '我要闹了'],
  ['girl', '哄不好了', '哄不好了'],
  ['cat', '气到咬人猫', '气到咬人'],
  ['cat', '你凶我猫', '你凶我'],

  // ── 求和 / 示弱 ──
  ['cat', '我错啦别凶我猫', '我错啦别凶我'],
  ['girl', '好了啦别气啦', '好了啦别气啦'],
  ['duck', '对不起鸭', '对不起'],
  ['cat', '算我求你的猫', '算我求你了'],
  ['cat', '不许凶我猫', '不许凶我'],

  // ── 早安 / 晚安 / 困 ──
  ['girl', '早上好呀-早安', '早上好'],
  ['girl', '晚安-困了-我睡了', '晚安我睡了'],
  ['cat', '我睡着惹', '我睡着啦'],
  ['cat', '不想起床猫', '不想起床'],
  ['cat', '困哈欠猫', '困了哈欠'],
  ['bear', '起床是什么', '起床是什么'],
  ['bear', '次饱了-吃饱了', '吃饱了'],

  // ── 日常 ──
  ['duck', '在干嘛鸭', '在干嘛'],
  ['duck', '尼在干嘛鸭', '你在干嘛'],
  ['duck', '刚下班鸭', '刚下班'],
  ['cat', '在吗猫', '在吗'],
  ['cat', '敲键盘猫', '敲键盘'],
  ['cat', '瘫会儿猫', '瘫会儿'],
  ['cat', '揣手手猫', '揣手手'],
  ['cat', '探头偷看猫', '探头偷看'],
  ['cat', '舔舔爪子猫', '舔爪子'],
  ['cat', '揉脸猫', '揉脸'],
  ['bear', '马上来', '马上来'],
  ['bear', '客气了', '客气了'],
  ['bear', '谢谢老板', '谢谢老板'],

  // ── 搞笑 / 沙雕（负鼠这一组是最近很火的）──
  ['opossum', '已深度思考', '已深度思考'],
  ['opossum', '收到办不到', '收到办不到'],
  ['opossum', '我没有梦想我只想玩', '没有梦想只想玩'],
  ['opossum', '已读不回是在细品', '已读不回是在细品'],
  ['opossum', '人生嘛看开点', '人生嘛看开点'],
  ['opossum', '前途一片阴暗好凉快', '前途一片阴暗好凉快'],
  ['opossum', '重生之我又回到了周一', '重生之又是周一'],
  ['opossum', '打不死我的一直在打我', '打不死我的一直在打我'],
  ['opossum', '复杂的事情简单做简单的事情我不想做', '简单的事我不想做'],
  ['opossum', '慢慢急不要来', '慢慢急不要来'],
  ['opossum', '命运给我开的玩笑我一个也没笑', '一个也没笑'],
  ['mur', '奇怪的知识增加了', '奇怪的知识增加了'],
  ['mur', '停止思考了', '停止思考'],
  ['mur', '思维升华', '思维升华'],
  ['mur', '问号', '问号'],
  ['duck', '翻车了鸭', '翻车了'],
  ['duck', '冲鸭', '冲鸭'],
  ['duck', '今天不想加油鸭', '今天不想加油'],
  ['duck', '带我玩鸭', '带我玩'],

  // ── 震惊 / 无语 ──
  ['cat', '震惊猫', '震惊'],
  ['cat', '喵瞪口呆猫', '目瞪口呆'],
  ['cat', '猫问号-疑问猫', '疑问'],
  ['cat', '凉了猫', '凉了'],
  ['cat', '苍天呐猫', '苍天呐'],
  ['duck', '哎鸭', '哎'],
  ['cat', '小声BB猫', '小声逼逼'],

  // ── 温柔 / 害羞 ──
  ['cat', '害羞猫', '害羞'],
  ['cat', '爱心猫', '爱心'],
  ['cat', '歪头看猫', '歪头看你'],
  ['cat', '拍头猫', '拍头'],
  ['cat', '击掌猫', '击掌'],
  ['cat', '点头如捣蒜猫', '点头'],

  // ── 关心你 ──
  ['bear', '你在哪', '你在哪'],
  ['bear', '为什么', '为什么'],
  ['bear', '木有-没有', '没有'],
  ['cat', '你醒啦猫', '你醒啦'],
];

// ── 拿到仓库文件列表（不下载图片内容）──
function repoTree() {
  // 允许用已克隆的仓库，省一次网络往返
  const cached = process.env.BQB_REPO;
  const dir = cached || path.join(process.env.TEMP || '/tmp', 'bqb-repo-' + Date.now());

  const has = (d) => fs.existsSync(path.join(d, '.git'));
  if (!has(dir)) {
    console.log('拉取目录树（不下图片，约 10 秒）…');
    fs.mkdirSync(dir, { recursive: true });
    const r = spawnSync('git', [
      'clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--quiet',
      `https://github.com/${REPO_SLUG}.git`, dir,
    ], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git clone 失败：${r.stderr || r.status}`);
  }

  const r = spawnSync('git', ['-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', 'HEAD'],
    { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ls-tree 失败：${r.stderr}`);

  const files = r.stdout.split('\n').filter(Boolean);
  // 临时克隆的用完就删
  if (!cached) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
  return files;
}

function pickFile(tree, cat, key) {
  const dir = CAT[cat];
  if (!dir) return null;
  const hits = tree.filter((f) => {
    if (!f.startsWith(`${dir}/`)) return false;
    const base = f.split('/').pop();
    return STICKER_EXT.includes(path.extname(base).toLowerCase()) && base.includes(key);
  });
  return hits[0] ?? null;
}

async function download(relPath, dest) {
  const encoded = relPath.split('/').map(encodeURIComponent).join('/');
  let lastErr = null;

  for (const mirror of MIRRORS) {
    const url = mirror(encoded);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) throw new Error('空文件');
        fs.writeFileSync(dest, buf);
        return buf.length;
      } catch (e) {
        lastErr = e;
        // 换个镜像前稍微等一下，别把限流打得更狠
        if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
      }
    }
  }
  throw new Error(lastErr?.message ?? '下载失败');
}

// ── 主流程 ──
const FORCE = process.argv.includes('--force');
const LIST_ONLY = process.argv.includes('--list');

ensureStickerDir();
const tree = LIST_ONLY ? [] : repoTree();

console.log('');
console.log(`表情包清单：${PICKS.length} 条`);
if (LIST_ONLY) {
  for (const [cat, key, name] of PICKS) console.log(`  ${name.padEnd(14)} ← ${cat}/${key}`);
  process.exit(0);
}
console.log(`仓库文件：${tree.length} 个`);
console.log('');

let ok = 0, skip = 0, miss = 0, bytes = 0;
const missing = [];

for (const [cat, key, name] of PICKS) {
  const rel = pickFile(tree, cat, key);
  if (!rel) { miss++; missing.push(`${cat}/${key} → 想叫「${name}」`); continue; }

  const ext = path.extname(rel).toLowerCase();
  const dest = path.join(STICKER_DIR, `${name}${ext}`);

  // 同名不同扩展的残留清掉，免得她有两个"晚安"
  for (const e of STICKER_EXT) {
    const other = path.join(STICKER_DIR, `${name}${e}`);
    if (other !== dest && fs.existsSync(other)) fs.rmSync(other, { force: true });
  }

  if (!FORCE && fs.existsSync(dest)) { skip++; continue; }

  try {
    const n = await download(rel, dest);
    bytes += n;
    ok++;

    // 仓库里确实有后缀名和内容不符的文件（「不许凶我.gif」其实是 JPEG）。
    // 按真实内容改名 —— 运行时虽然会嗅探文件头，但文件名骗人总有一天坑到人。
    const sniffed = sniffImage(fs.readFileSync(dest));
    let finalName = `${name}${ext}`;
    if (sniffed && sniffed.ext !== ext) {
      const fixed = path.join(STICKER_DIR, `${name}${sniffed.ext}`);
      fs.renameSync(dest, fixed);
      finalName = `${name}${sniffed.ext}`;
      process.stdout.write(`  ~ ${name.padEnd(14)} ${String(Math.round(n / 1024)).padStart(4)}KB  `
        + `（仓库标的是 ${ext}，实际是 ${sniffed.ext}，已改名）\n`);
    } else {
      process.stdout.write(`  ✓ ${name.padEnd(14)} ${String(Math.round(n / 1024)).padStart(4)}KB\n`);
    }
    void finalName;
  } catch (e) {
    miss++;
    missing.push(`${name}（${e.message}）`);
  }
}

// 顺带把库里遗留的"后缀名骗人"文件也纠正一遍（比如之前版本下载的）
let repaired = 0;
for (const s of fs.existsSync(STICKER_DIR) ? fs.readdirSync(STICKER_DIR) : []) {
  const declared = path.extname(s).toLowerCase();
  if (!STICKER_EXT.includes(declared)) continue;
  const full = path.join(STICKER_DIR, s);
  const sniffed = sniffImage(fs.readFileSync(full));
  if (!sniffed || sniffed.ext === declared) continue;
  if (declared === '.jpeg' && sniffed.ext === '.jpg') continue;
  const fixed = path.join(STICKER_DIR, `${path.basename(s, declared)}${sniffed.ext}`);
  if (fs.existsSync(fixed)) continue; // 别覆盖同名文件
  fs.renameSync(full, fixed);
  repaired++;
}
if (repaired) console.log(`\n  顺手纠正了 ${repaired} 个后缀名和内容不符的老文件`);

console.log('');
console.log('─'.repeat(60));
console.log(`  新下载 ${ok} 个，已存在跳过 ${skip} 个，拿不到 ${miss} 个`);
if (bytes) console.log(`  本次共 ${Math.round(bytes / 1024)} KB`);
if (missing.length) {
  console.log('  没拿到的（仓库可能改过名）：');
  for (const m of missing) console.log(`    · ${m}`);
}
console.log('');
console.log(`  表情包目录：${STICKER_DIR}`);
console.log('  提醒：这些图版权属于原作者，自己用可以，别随包分发。');
console.log('        （data/ 已经被 .gitignore 和 pack.js 排除，打包不会带上）');
console.log('');
