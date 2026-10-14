// 扫码绑定流程：把手机上的微信号接成她说话的出口。
//
// 流程（微信 iLink 官方机器人通道）：
//   1. 取二维码 → 用手机微信扫
//   2. 手机上会显示一个配对码
//   3. 在终端输入配对码 → 服务端返回 bot_token
//   4. bot_token 落盘到 data/config.json

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig, saveConfig, DATA_DIR } from './config.js';
import * as ilink from './channel/ilink.js';
import { encodeQr } from './qrcode.js';

const QR_IMAGE = path.join(DATA_DIR, 'login-qrcode.png');

/**
 * 跑一次完整的扫码绑定。
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function runLogin({ logger = console.log } = {}) {
  const cfg = loadConfig();
  const baseUrl = cfg.channel.apiBase;

  logger('');
  logger('══ 扫码绑定微信号 ══');
  logger('');

  let qr;
  try {
    qr = await ilink.startLoginQr({ baseUrl });
  } catch (err) {
    logger(`✗ 取二维码失败: ${err.message}`);
    logger('  请检查网络能否访问 ilinkai.weixin.qq.com');
    return { ok: false, reason: err.message };
  }

  // 服务端实际返回（已实测）：
  //   { qrcode: "b730c058...", qrcode_img_content: "https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=...&bot_type=3", ret: 0 }
  // 注意 qrcode_img_content 是**一个短链**，不是图片内容 —— 名字有误导性。
  const qrcode = qr.qrcode ?? qr.qrcode_id ?? qr.qr_id ?? '';
  const qrLink = typeof qr.qrcode_img_content === 'string' && qr.qrcode_img_content.includes('://')
    ? qr.qrcode_img_content
    : (qr.qrcode_url ?? qr.url ?? '');
  const qrImageUrl = qr.qrcode_img_url ?? qr.img_url ?? '';

  if (!qrcode) {
    logger(`✗ 服务端未返回 qrcode。原始响应：${JSON.stringify(qr).slice(0, 400)}`);
    return { ok: false, reason: '服务端未返回 qrcode' };
  }

  // 把链接生成二维码图片，方便直接扫；同时给出链接本身作为兜底
  const imageData = await renderQrImage(qrLink, qrImageUrl);
  if (imageData) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(QR_IMAGE, imageData);
  }

  logger('══ 怎么扫这个码 ══');
  logger('');
  if (imageData) {
    logger(`  📱 二维码图片已保存到：`);
    logger(`     ${QR_IMAGE}`);
    logger('');
    logger('  双击打开这张图片，用手机微信「扫一扫」扫它。');
    logger('');
    logger('  ⚠️  必须用微信扫，不能用系统相机或其他 App。');
  } else {
    logger('  二维码链接（在手机上打开它，或用二维码工具把它转成图）：');
    logger('');
    logger(`  ${qrLink}`);
  }
  logger('');
  if (qrLink) logger(`  链接原文：${qrLink}`);
  logger(`  （这个码是刚生成的，有效期约 3 分钟）`);
  logger('');
  logger('等待扫码…');
  const deadline = Date.now() + 3 * 60_000;
  let status = null;

  while (Date.now() < deadline) {
    await sleep(2000);
    try {
      status = await ilink.pollLoginQrStatus(qrcode, { baseUrl });
    } catch (err) {
      logger(`  轮询出错（继续重试）: ${err.message}`);
      continue;
    }

    const st = status?.status ?? status?.state ?? status?.qr_status;

    if (st === 2 || st === 'confirmed' || st === 'scanned') {
      logger('✓ 已扫码');
      break;
    }
    if (status?.bot_token || status?.token) {
      break;
    }
    if (st === 0 || st === 'expired' || st === 'canceled') {
      logger('✗ 二维码已过期或已取消，请重新运行 npm run login');
      return { ok: false, reason: '二维码过期' };
    }
    process.stdout.write('.');
  }

  logger('');

  // 服务端可能直接给 token，也可能要配对码
  let botToken = status?.bot_token ?? status?.token ?? '';
  let ilinkUserId = status?.ilink_user_id ?? status?.bot_id ?? status?.user_id ?? '';

  if (!botToken) {
    const pairing = status?.pairing_code ?? status?.code ?? '';
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const answer = await new Promise((resolve) => {
      const hint = pairing ? `（服务端提示配对码：${pairing}）` : '';
      rl.question(`请输入手机上显示的配对码${hint}: `, resolve);
    });
    rl.close();

    // 把配对码提交给服务端换 token
    try {
      const res = await fetch(
        `${baseUrl}/ilink/bot/get_bot_token?qrcode=${encodeURIComponent(qrcode)}&pairing_code=${encodeURIComponent(answer.trim())}`,
        { method: 'GET', signal: AbortSignal.timeout(20_000) },
      );
      const data = await res.json();
      botToken = data?.bot_token ?? data?.token ?? '';
      ilinkUserId = ilinkUserId || (data?.ilink_user_id ?? data?.bot_id ?? '');
      if (!botToken) {
        logger(`✗ 换取 token 失败: ${JSON.stringify(data).slice(0, 300)}`);
        return { ok: false, reason: '换取 token 失败' };
      }
    } catch (err) {
      logger(`✗ 换取 token 出错: ${err.message}`);
      return { ok: false, reason: err.message };
    }
  }

  if (!botToken) {
    logger('✗ 未能获得 bot_token。原始状态响应：');
    logger(`  ${JSON.stringify(status).slice(0, 500)}`);
    return { ok: false, reason: '未获得 bot_token' };
  }

  cfg.channel.botToken = botToken;
  cfg.channel.ilinkUserId = ilinkUserId;
  cfg.channel.boundAt = new Date().toISOString();
  saveConfig(cfg);

  logger('');
  logger('✓ 绑定成功！');
  logger(`  bot_token 已写入 ${path.join(DATA_DIR, 'config.json')}`);
  logger('');
  logger('  下一步：');
  logger('    1. 运行  npm run doctor   检查配置');
  logger('    2. 运行  npm start        启动她');
  logger('    3. 用微信给这个机器人发一句话试试');
  logger('');

  return { ok: true };
}

/**
 * 把二维码链接渲染成可扫的形式。
 *
 * 零依赖环境下有个硬约束：Node 没有内置 QR 编码器，也没有图像库。
 * 所以策略是「三级降级」，每级都可用：
 *   1. 终端字符画（最方便 —— 直接在终端里扫，不用切窗口）
 *   2. 存成 .svg 文件（矢量、任何看图软件都能开）
 *   3. 打印链接（最兜底）
 *
 * 返回 { mode, svgPath } 用于日志提示。
 */
async function renderQrImage(qrLink, qrImageUrl) {
  // 服务端若直接给了图片地址，优先用它
  if (qrImageUrl) {
    try {
      const res = await fetch(qrImageUrl, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 100) {
          fs.mkdirSync(DATA_DIR, { recursive: true });
          fs.writeFileSync(QR_IMAGE, buf);
          return 'png';
        }
      }
    } catch { /* 继续降级 */ }
  }

  if (!qrLink) return null;

  // 用内置的 QR 编码实现生成矩阵，再渲染成终端字符画 + SVG
  try {
    const matrix = encodeQr(qrLink);
    if (!matrix) return null;

    printQrToTerminal(matrix);

    const svg = qrToSvg(matrix);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'login-qrcode.svg'), svg, 'utf8');
    return 'svg';
  } catch {
    return null;
  }
}

/** 在终端里用 Unicode 半块字符画出二维码（上半块+下半块，一行顶两行）。 */
function printQrToTerminal(matrix) {
  const size = matrix.length;
  const quiet = 2; // 静区
  const lines = [];

  // 白边
  const blank = '  '.repeat(size + quiet * 2);
  for (let i = 0; i < quiet; i++) lines.push(blank);

  // 两行像素压成一行字符：▀ 上黑下白、▄ 上白下黑、█ 都黑、空格 都白
  for (let y = 0; y < size; y += 2) {
    let line = '  '.repeat(quiet);
    for (let x = 0; x < size; x++) {
      const top = matrix[y][x];
      const bottom = y + 1 < size ? matrix[y + 1][x] : false;
      if (top && bottom) line += '█';
      else if (top) line += '▀';
      else if (bottom) line += '▄';
      else line += ' ';
    }
    line += '  '.repeat(quiet);
    lines.push(line);
  }

  for (let i = 0; i < quiet; i++) lines.push(blank);

  console.log('');
  for (const l of lines) console.log(l);
  console.log('');
}

/** 把矩阵转成 SVG。 */
function qrToSvg(matrix) {
  const size = matrix.length;
  const quiet = 4;
  const total = size + quiet * 2;
  let d = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (matrix[y][x]) d += `M${x + quiet},${y + quiet}h1v1h-1z`;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="480" height="480" shape-rendering="crispEdges">
<rect width="${total}" height="${total}" fill="#ffffff"/>
<path d="${d}" fill="#000000"/>
</svg>
`;
}

export { renderQrImage, printQrToTerminal, qrToSvg };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
