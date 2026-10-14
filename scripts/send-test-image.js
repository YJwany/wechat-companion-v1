// 发一张**内容明确**的图到微信，用于肉眼确认图片渲染正常。
//
// 用彩色条纹 + 文字，任何加密/字段错误都会立刻看出来（花屏、空白、模糊）。
import { loadConfig } from '../src/config.js';
import * as ilink from '../src/channel/ilink.js';
import { uploadMediaToCdn, buildImageItem, md5Hex, aesKeyToHex } from '../src/channel/media.js';
import { readPhoto, PHOTO_DIR } from '../src/soul/album.js';
import path from 'node:path';

const cfg = loadConfig();
const peer = cfg.moments.autoSendTo || cfg.channel.ilinkUserId;
const creds = {
  botToken: cfg.channel.botToken,
  apiBase: cfg.channel.apiBase,
  cdnBaseUrl: cfg.channel.cdnBaseUrl,
};

const target = path.join(PHOTO_DIR, '验证图-彩色条纹.jpg');
const original = readPhoto(target);

console.log('发送验证图');
console.log('  文件:', target);
console.log('  大小:', original.length, '字节');
console.log('  md5 :', md5Hex(original));
console.log('');

const up = await uploadMediaToCdn(creds, original, peer, 'image');
const item = buildImageItem(up);

console.log('  上传完成');
console.log('  明文长度:', up.fileSize, '/ 密文长度:', up.fileSizeCiphertext);
console.log('  aeskey(hex,32位):', aesKeyToHex(up.aesKeyBase64));
console.log('  item 字段:', Object.keys(item.image_item).join(', '));
console.log('');

await ilink.sendMessage(creds, peer, [item], '');
await ilink.sendTextMessage(creds, peer, '这是验证图，应该能看到彩色条纹和文字', '');

console.log('  ✓ 已发送');
console.log('');
console.log('请在微信里确认：');
console.log('  1. 图片能正常显示（不是空白）');
console.log('  2. 能看清五条彩色横条 + 底部圆形');
console.log('  3. 文字 "TEST 1234 ABCD" 可辨认');
