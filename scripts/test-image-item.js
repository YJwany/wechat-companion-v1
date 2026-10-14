// 验证出站 item 构造：密钥字段必须是能被接收端解析的正确形态。
import { buildImageItem, aesKeyToHex, parseAesKey } from '../src/channel/media.js';
import crypto from 'node:crypto';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${name}`); pass++; } else { console.log(`  ✗ ${name} ${extra}`); fail++; }
}

console.log('出站图片 item 字段验证');
console.log('─'.repeat(60));

// 真实场景：上传时随机生成 16 字节密钥
for (let i = 0; i < 3; i++) {
  const raw = crypto.randomBytes(16);
  const aesKeyBase64 = Buffer.from(raw.toString('hex')).toString('base64');

  const item = buildImageItem({
    encryptQueryParam: 'SOME_PARAM',
    aesKeyBase64,
    fileSize: 10397,
    fileSizeCiphertext: 10400,
  });

  const it = item.image_item;
  const okType = item.type === 2;
  const okMedia = it.media.encrypt_type === 1 && it.media.encrypt_query_param === 'SOME_PARAM';
  const okAeskey = /^[0-9a-fA-F]{32}$/.test(it.aeskey);
  const okSame = it.aeskey === raw.toString('hex');
  // 关键：接收端要能用两种方式都解出同一个密钥
  const viaHex = Buffer.from(it.aeskey, 'hex');
  const viaB64 = parseAesKey(it.media.aes_key);
  const okBoth = viaHex.equals(raw) && viaB64 && viaB64.equals(raw);

  if (i === 0) {
    check('type 为 2（图片）', okType);
    check('media.encrypt_type 为 1', okMedia);
    check('顶层 aeskey 是 32 位 hex', okAeskey, `实际: ${it.aeskey}`);
    check('顶层 aeskey 与真密钥一致', okSame);
    check('两种密钥形态解出同一密钥', okBoth);
    check('mid_size 用密文长度', it.mid_size === 10400);
    check('len 用明文长度', it.len === '10397');
  } else {
    check(`第 ${i + 1} 次随机密钥同样正确`, okAeskey && okSame && okBoth);
  }
}

console.log('');
console.log('─'.repeat(60));
console.log(`通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
