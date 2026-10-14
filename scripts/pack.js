#!/usr/bin/env node
// 打包：把项目打成可以直接拷给别人的压缩包。
//
// 关键取舍：**绝不打包 data/**。
// data/config.json 里存着 bot_token 和 API Key —— 打包给别人等于把自己的
// 密钥送出去。这个脚本会主动检查并拒绝打包任何密钥文件。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(ROOT, 'dist');

// 打包白名单：只带运行必需的源码和文档
const INCLUDE = [
  'package.json',
  'README.md',
  '.gitignore',
  'docs',
  'src',
  'scripts',
  'test',
];

// 明确排除（就算在 include 目录里也跳过）
export const EXCLUDE = [
  'node_modules',
  '_reference',       // 参考仓库是第三方代码，几百 MB，且授权不明
  'data',             // 含密钥！
  'backups',          // 自动备份是 data/ 的整份拷贝 —— 同样含密钥，绝不能进交付包
  '.test-data',       // 测试用的临时数据目录，同样是 data/ 的拷贝
  '.test-backups',
  '.test-data-core',  // npm test 的临时数据目录（scripts/run-core-tests.js）
  '.test-backups-core',
  'dist',
  '.git',
];

// 这些文件名一旦出现就要报警
const SECRET_FILES = ['config.json', 'state.json', 'memory.json'];

function walk(dir, base = '') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (EXCLUDE.some((x) => rel === x || rel.startsWith(`${x}/`))) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, rel));
    else if (e.isFile()) out.push({ rel, full, size: fs.statSync(full).size });
  }
  return out;
}

console.log('');
console.log('════════ 打包 ════════');
console.log('');

const files = [];
for (const inc of INCLUDE) {
  const full = path.join(ROOT, inc);
  if (!fs.existsSync(full)) continue;
  const st = fs.statSync(full);
  if (st.isDirectory()) files.push(...walk(full, inc));
  else files.push({ rel: inc, full, size: st.size });
}

// ── 安全检查：绝不能把密钥打进去 ──
console.log('安全检查…');
let danger = 0;
for (const f of files) {
  const name = path.basename(f.rel);
  if (SECRET_FILES.includes(name)) {
    console.log(`  ✗ 危险：${f.rel} 含密钥，已阻止打包`);
    danger++;
  }
}
// 再扫一遍内容，防止密钥藏在别的文件里
const KEY_RE = /sk-[a-zA-Z0-9]{20,}/;
for (const f of files) {
  if (!/\.(js|json|md|html)$/.test(f.rel)) continue;
  try {
    const text = fs.readFileSync(f.full, 'utf8');
    if (KEY_RE.test(text)) {
      console.log(`  ✗ 危险：${f.rel} 里发现了疑似 API Key`);
      danger++;
    }
  } catch { /* 读不了就跳过 */ }
}

if (danger) {
  console.log('');
  console.log(`发现 ${danger} 处密钥风险，已中止打包。`);
  console.log('请把密钥从源码里挪到 data/config.json（该目录不参与打包）。');
  process.exit(1);
}
console.log('  ✓ 没有发现密钥');

// ── 统计 ──
const totalBytes = files.reduce((s, f) => s + f.size, 0);
console.log('');
console.log(`共 ${files.length} 个文件，${(totalBytes / 1024).toFixed(0)} KB`);
console.log('');
for (const f of files.sort((a, b) => a.rel.localeCompare(b.rel))) {
  console.log(`  ${String(f.size).padStart(8)}  ${f.rel}`);
}

// ── 生成清单 ──
fs.mkdirSync(OUT_DIR, { recursive: true });
const manifest = {
  generatedAt: new Date().toISOString(),
  fileCount: files.length,
  totalBytes,
  files: files.map((f) => ({ path: f.rel, size: f.size })),
};
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

// ── 实际打包（用 tar，Windows 10+ 自带）──
console.log('');
const stamp = new Date().toISOString().slice(0, 10);
const tarName = `wechat-companion-${stamp}.tar.gz`;
const tarPath = path.join(OUT_DIR, tarName);

const { spawnSync } = await import('node:child_process');
const listFile = path.join(OUT_DIR, '.packlist');
fs.writeFileSync(listFile, files.map((f) => f.rel).join('\n'), 'utf8');

const r = spawnSync('tar', ['-czf', tarPath, '-T', listFile], { cwd: ROOT, stdio: 'inherit' });
fs.unlinkSync(listFile);

if (r.status === 0 && fs.existsSync(tarPath)) {
  const size = fs.statSync(tarPath).size;
  console.log('');
  console.log('════════════════════════════════');
  console.log('✓ 打包完成');
  console.log('════════════════════════════════');
  console.log('');
  console.log(`  ${tarPath}`);
  console.log(`  ${(size / 1024).toFixed(0)} KB`);
  console.log('');
  console.log('  别人拿到后解压，然后：');
  console.log('    1. 确认装了 Node 22+');
  console.log('    2. npm run login    扫码绑定他自己的微信');
  console.log('    3. 控制台里填他自己的模型 API Key');
  console.log('    4. npm start');
  console.log('');
} else {
  console.log('');
  console.log('tar 打包失败（可能系统没装 tar）。');
  console.log('可以手动拷贝这些文件和目录：');
  for (const inc of INCLUDE) console.log('  - ' + inc);
  console.log('');
  console.log('注意：**不要拷 data/**（里面有你的密钥）。');
}
