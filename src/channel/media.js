// 微信 CDN 媒体编解码：AES-128-ECB + PKCS7 的下载解密与加密上传。
//
// 协议形状（与 iLink 机器人通道一致）：
//   下载：GET  {cdn}/download?encrypted_query_param=<param>
//   上传：POST {api}/ilink/bot/getuploadurl {filekey, media_type, to_user_id,
//               rawsize, rawfilemd5, filesize, no_need_thumb, aeskey}
//             → {upload_param} 或 {upload_full_url}
//         再 POST {cdn}/upload?encrypted_query_param=<upload_param>&filekey=...
//         响应头 x-encrypted-param 即回传给 sendmessage 的下载参数。

import crypto from 'node:crypto';
import { DEFAULT_CDN_BASE, getUploadUrl } from './ilink.js';

export const MAX_MEDIA_SIZE = 100 * 1024 * 1024; // 100 MB

/** 入站 item.type → 媒体种类。 */
const MEDIA_ITEMS = {
  2: { kind: 'image', field: 'image_item' },
  3: { kind: 'voice', field: 'voice_item' },
  4: { kind: 'file', field: 'file_item' },
  5: { kind: 'video', field: 'video_item' },
};

/** 出站上传的 UploadMediaType 取值。 */
const UPLOAD_TYPE = { image: 1, video: 2, file: 3, voice: 4 };

/**
 * 解析 CDNMedia.aes_key（base64）为 16 字节原始密钥。
 * 观察到两种编码：16 字节原始密钥的 base64，或 32 字符 hex 字符串的 base64。
 */
export function parseAesKey(aesKeyBase64) {
  if (!aesKeyBase64) return undefined;
  let decoded;
  try {
    decoded = Buffer.from(aesKeyBase64, 'base64');
  } catch {
    return undefined;
  }
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  return undefined;
}

/** AES-128-ECB 解密，PKCS7 自动补位，失败则回退为不补位。 */
export function decryptAesEcb(cipher, key) {
  for (const autoPadding of [true, false]) {
    try {
      const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
      decipher.setAutoPadding(autoPadding);
      return Buffer.concat([decipher.update(cipher), decipher.final()]);
    } catch {
      /* 换另一种补位模式重试 */
    }
  }
  throw new Error('微信媒体解密失败（AES-128-ECB）');
}

/** AES-128-ECB 加密，PKCS7 补位。 */
export function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** 明文经 AES-128-ECB + PKCS7 后的密文长度（补齐到 16 字节边界）。 */
export function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

export function md5Hex(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

/**
 * 下载并解密一条入站媒体。
 * @returns {{data: Buffer, kind: string, fileName?: string}|null} 无媒体时返回 null
 */
export async function downloadMediaFromItem(item, cdnBaseUrl = DEFAULT_CDN_BASE) {
  const spec = MEDIA_ITEMS[item.type];
  if (!spec) return null;

  const payload = item[spec.field];
  const media = payload?.media;
  if (!media?.encrypt_query_param) return null;

  const url = `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`微信 CDN 下载失败: ${res.status} ${res.statusText}`);

  const encrypted = Buffer.from(await res.arrayBuffer());
  if (encrypted.length > MAX_MEDIA_SIZE) {
    throw new Error(`微信媒体超过 ${MAX_MEDIA_SIZE} 字节上限`);
  }

  // 图片优先用 item 上的 hex aeskey；其余种类回退 media.aes_key（base64）。
  // 没有密钥说明该 CDN 对象是明文。
  let aesKey;
  if (spec.kind === 'image' && typeof payload.aeskey === 'string' && /^[0-9a-fA-F]{32}$/.test(payload.aeskey)) {
    aesKey = Buffer.from(payload.aeskey, 'hex');
  } else {
    aesKey = parseAesKey(media.aes_key);
  }

  const data = aesKey ? decryptAesEcb(encrypted, aesKey) : encrypted;

  const result = { data, kind: spec.kind };
  if (spec.kind === 'file' && payload.file_name) result.fileName = payload.file_name;
  return result;
}

/**
 * 加密并上传一个媒体 Buffer 到微信 CDN。
 * @returns sendmessage 出站 item 的 media 字段所需数据
 */
export async function uploadMediaToCdn(creds, data, toUserId, mediaType, cdnBaseUrl = creds.cdnBaseUrl || DEFAULT_CDN_BASE) {
  const rawsize = data.length;
  const rawfilemd5 = md5Hex(data);
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString('hex');
  const aeskey = crypto.randomBytes(16);

  const resp = await getUploadUrl(creds, {
    filekey,
    media_type: UPLOAD_TYPE[mediaType] ?? UPLOAD_TYPE.file,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString('hex'),
  });

  const uploadParam = resp.upload_param;
  if (!uploadParam && !resp.upload_full_url) {
    throw new Error('getuploadurl 未返回 upload_param 也未返回 upload_full_url');
  }

  // 服务端可能给完整上传地址，也可能只给参数；两者携带同一张加密上传票据。
  const uploadUrl = resp.upload_full_url
    ? `${resp.upload_full_url}${resp.upload_full_url.includes('?') ? '&' : '?'}filekey=${encodeURIComponent(filekey)}`
    : `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;

  const ciphertext = encryptAesEcb(data, aeskey);

  let downloadParam;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const put = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
        signal: AbortSignal.timeout(180_000),
      });
      if (put.status !== 200) {
        const errMsg = put.headers.get('x-error-message') ?? `status ${put.status}`;
        throw new Error(`微信 CDN 上传失败: ${errMsg}`);
      }
      downloadParam = put.headers.get('x-encrypted-param') ?? undefined;
      if (!downloadParam) throw new Error('CDN 上传响应缺少 x-encrypted-param 头');
      break;
    } catch (err) {
      lastError = err;
      if (attempt >= 3) break;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  if (!downloadParam) {
    throw lastError instanceof Error ? lastError : new Error('CDN 上传重试 3 次仍失败');
  }

  return {
    encryptQueryParam: downloadParam,
    // CDNMedia.aes_key 是密钥的 hex 字符串再按 UTF-8 做 base64；
    // 接收端解回 32 字符 hex 再 hex 解码。
    aesKeyBase64: Buffer.from(aeskey.toString('hex')).toString('base64'),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

/**
 * 构造一条出站图片 item。
 *
 * 字段取舍（对照参考实现 + 自己的接收端得出的结论）：
 *   - `media.aes_key` 是 base64(32 字符 hex 字符串)，协议里的通用形态
 *   - 顶层 `aeskey` 是**32 字符的十六进制密钥**，接收端读图片密钥时优先取它，
 *     取不到才回退 media.aes_key。
 *
 *   ⚠️ 参考实现这里有个 bug：它用 `Buffer.from(base64,'base64').toString('hex')`
 *   得到 64 字符，而它自己的校验要求 /^[0-9a-fA-F]{32}$/ —— 永远不匹配，
 *   等于白给。正确做法是 `.toString('ascii')` 拿到 hex 字符串本身（32 字符）。
 *   这里按正确实现给，并且发出去前自己先校验长度，防止再次写错。
 */
export function buildImageItem(uploaded) {
  const aeskey = aesKeyToHex(uploaded.aesKeyBase64);

  return {
    type: 2,
    image_item: {
      media: {
        encrypt_query_param: uploaded.encryptQueryParam,
        aes_key: uploaded.aesKeyBase64,
        encrypt_type: 1,
      },
      // 只在确实拿到 32 位 hex 时才带，避免给出一个对端解析不了的废字段
      ...(aeskey ? { aeskey } : {}),
      mid_size: uploaded.fileSizeCiphertext,
      len: String(uploaded.fileSize),
    },
  };
}

/**
 * 把 base64(hex字符串) 还原成 32 字符的十六进制密钥。
 *
 * base64 解出来是 ASCII 的 32 个 hex 字符（不是 16 字节二进制），
 * 所以必须用 ascii 解码，再用 hex 解码才是真正的 16 字节密钥。
 */
export function aesKeyToHex(aesKeyBase64) {
  if (!aesKeyBase64) return '';
  try {
    const ascii = Buffer.from(String(aesKeyBase64), 'base64').toString('ascii');
    return /^[0-9a-fA-F]{32}$/.test(ascii) ? ascii : '';
  } catch {
    return '';
  }
}

/** 构造一条出站文件 item。 */
export function buildFileItem(uploaded, fileName) {
  return {
    type: 4,
    file_item: {
      media: {
        encrypt_query_param: uploaded.encryptQueryParam,
        aes_key: uploaded.aesKeyBase64,
        encrypt_type: 1,
      },
      file_name: fileName,
      len: String(uploaded.fileSize),
    },
  };
}

/** 构造一条出站语音 item（当前通道能力待验证，保留接口）。 */
export function buildVoiceItem(uploaded, durationMs = 0) {
  return {
    type: 3,
    voice_item: {
      media: {
        encrypt_query_param: uploaded.encryptQueryParam,
        aes_key: uploaded.aesKeyBase64,
        encrypt_type: 1,
      },
      duration: durationMs,
    },
  };
}
