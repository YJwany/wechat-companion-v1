#!/usr/bin/env node
// 扫码绑定 —— 交互友好版。
//
// 为什么单独写一个：程序自带的 npm run login 是为"你自己在终端里跑"设计的，
// 但如果由 AI 助手代跑，会遇到两个麻烦：
//   1. 非交互环境无法输入配对码
//   2. 终端里的字符画二维码不好转给用户
//
// 这个脚本做两件事：把二维码存成**能直接双击打开的图片**，然后等扫码。
// 你可以自己跑，也可以让助手跑（助手跑的话你只管扫图片）。

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig, saveConfig, DATA_DIR } from '../src/config.js';
import * as ilink from '../src/channel/ilink.js';
import { encodeQr } from '../src/qrcode.js';
import { qrToSvg, printQrToTerminal } from '../src/login.js';

const cfg = loadConfig();
const baseUrl = cfg.channel.apiBase;

console.log('');
console.log('════════ 微信伴侣 · 扫码绑定 ════════');
console.log('');

// ── 1. 取二维码 ──
let qr;
try {
  qr = await ilink.startLoginQr({ baseUrl });
} catch (err) {
  console.error('✗ 取二维码失败:', err.message);
  process.exit(1);
}

const qrcode = qr.qrcode ?? '';
const link = qr.qrcode_img_content ?? '';
if (!qrcode || !link) {
  console.error('✗ 服务端返回异常:', JSON.stringify(qr));
  process.exit(1);
}

// ── 2. 生成二维码图片（SVG，双击即可打开）──
const matrix = encodeQr(link);
fs.mkdirSync(DATA_DIR, { recursive: true });

const svgPath = path.join(DATA_DIR, '扫码绑定.svg');
fs.writeFileSync(svgPath, qrToSvg(matrix), 'utf8');

console.log('二维码已生成。两种扫法，任选一种：');
console.log('');
console.log('【方法一】直接扫下面这个（在终端里）');
printQrToTerminal(matrix);
console.log('');
console.log('【方法二】双击打开这张图片再扫（更大更清楚）');
console.log(`         ${svgPath}`);
console.log('');

// 自动尝试打开图片
try {
  const { spawn } = await import('node:child_process');
  spawn('cmd', ['/c', 'start', '', svgPath], { detached: true, stdio: 'ignore' }).unref();
  console.log('  （已尝试自动打开）');
} catch { /* 打不开就算了，用户手动开 */ }

console.log('');
console.log('⚠️  必须用手机微信的「扫一扫」，不能用系统相机。');
console.log(`   这个码有效期约 3 分钟，链接：${link}`);
console.log('');
console.log('等待扫码…（每 2 秒查一次，最多 3 分钟）');
console.log('');

// ── 3. 轮询 ──
const deadline = Date.now() + 3 * 60_000;
let status = null;
let lastStatus = '';

while (Date.now() < deadline) {
  await sleep(2000);
  try {
    status = await ilink.pollLoginQrStatus(qrcode, { baseUrl });
  } catch (err) {
    process.stdout.write('?');
    continue;
  }

  const st = status?.status ?? '';
  if (st !== lastStatus) {
    lastStatus = st;
    console.log('');
    if (st === 'wait') console.log('  [等待扫码]');
    else if (st === 'scanned' || st === 'confirmed' || st === 2) console.log('  [已扫码，等待确认]');
    else console.log(`  [状态: ${st || JSON.stringify(status).slice(0, 120)}]`);
  }
  process.stdout.write('.');

  // 拿到 token 就结束
  if (status?.bot_token) break;
  if (st === 'confirmed' || st === 'success') break;
  // 明确失败
  if (st === 'expired' || st === 'canceled') {
    console.log('\n✗ 二维码已过期或被取消，请重新运行本脚本');
    process.exit(1);
  }
}

console.log('');
console.log('');

const botToken = status?.bot_token ?? status?.token ?? '';
const ilinkUserId = status?.ilink_user_id ?? status?.bot_id ?? '';

if (!botToken) {
  console.log('══ 最终状态 ══');
  console.log(JSON.stringify(status, null, 2));
  console.log('');
  console.log('还没拿到 bot_token。');
  console.log('如果手机提示要输入配对码，请在本终端里输入。');
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise((res) => rl.question('配对码（没有就直接回车跳过）: ', res));
  rl.close();

  if (code.trim()) {
    console.log('正在用配对码换取 token…');
    try {
      const res = await fetch(
        `${baseUrl}/ilink/bot/get_bot_token?qrcode=${encodeURIComponent(qrcode)}&pairing_code=${encodeURIComponent(code.trim())}`,
        { signal: AbortSignal.timeout(20_000) },
      );
      const data = await res.json();
      console.log('服务端返回:', JSON.stringify(data).slice(0, 300));
      const tk = data?.bot_token ?? data?.token ?? '';
      if (tk) {
        saveBinding(tk, data?.ilink_user_id ?? data?.bot_id ?? '');
        process.exit(0);
      }
    } catch (err) {
      console.log('换取失败:', err.message);
    }
    console.log('✗ 未能完成绑定');
    process.exit(1);
  }
  process.exit(1);
}

saveBinding(botToken, ilinkUserId);

function saveBinding(token, uid) {
  const c = loadConfig();
  c.channel.botToken = token;
  c.channel.ilinkUserId = uid;
  c.channel.boundAt = new Date().toISOString();
  saveConfig(c);
  console.log('════════════════════════════════');
  console.log('✓ 绑定成功！');
  console.log('════════════════════════════════');
  console.log('');
  console.log(`  bot_token: ${token.slice(0, 16)}…（已写入 data/config.json）`);
  if (uid) console.log(`  账号 ID  : ${uid}`);
  console.log('');
  console.log('  下一步：运行  npm start  启动她');
  console.log('');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
