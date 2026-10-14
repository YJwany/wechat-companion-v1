// 端到端测试：她真的能把照片发到微信。
// 这一步验证的是 AES 加密上传 + 出站 item 构造，最容易出错的地方。
import { loadConfig } from '../src/config.js';
import * as ilink from '../src/channel/ilink.js';
import { uploadMediaToCdn, buildImageItem } from '../src/channel/media.js';
import { listPhotos, readPhoto } from '../src/soul/album.js';

const cfg = loadConfig();
const peer = cfg.moments.autoSendTo || cfg.channel.ilinkUserId;
if (!peer) { console.error('没有可发送的对象'); process.exit(1); }

const creds = {
  botToken: cfg.channel.botToken,
  apiBase: cfg.channel.apiBase,
  cdnBaseUrl: cfg.channel.cdnBaseUrl,
};

console.log('接收方:', peer);
console.log('');

const photos = listPhotos();
if (!photos.length) { console.error('相册为空'); process.exit(1); }

const photo = photos[0];
console.log('1. 读取照片:', photo.name, `(${Math.round(photo.size / 1024)}KB)`);
const bytes = readPhoto(photo.path);
console.log('   原始字节:', bytes.length);
console.log('   文件头:', bytes.subarray(0, 4).toString('hex'), '(ffd8ff = JPEG)');

console.log('');
console.log('2. 加密并上传到微信 CDN…');
const t0 = Date.now();
let uploaded;
try {
  uploaded = await uploadMediaToCdn(creds, bytes, peer, 'image');
  console.log(`   ✓ 上传成功 (${Date.now() - t0}ms)`);
  console.log('   download param:', String(uploaded.downloadParam ?? '').slice(0, 60) + '…');
  console.log('   aes_key:', String(uploaded.aesKey ?? uploaded.aes_key ?? '').slice(0, 30) + '…');
} catch (err) {
  console.error('   ✗ 上传失败:', err.message);
  process.exit(1);
}

console.log('');
console.log('3. 构造出站 item…');
const item = buildImageItem(uploaded);
console.log('   ' + JSON.stringify(item).slice(0, 300));

console.log('');
console.log('4. 发送…');
try {
  await ilink.sendMessage(creds, peer, [item], '');
  console.log('   ✓ 照片已发送！去看微信');
} catch (err) {
  console.error('   ✗ 发送失败:', err.message);
  process.exit(1);
}

console.log('');
console.log('5. 补一句配文…');
try {
  await ilink.sendTextMessage(creds, peer, '今天的光挺好的', '');
  console.log('   ✓ 配文已发送');
} catch (err) {
  console.error('   ✗ 配文失败:', err.message);
}
