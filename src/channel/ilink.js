// iLink 机器人 HTTP 协议客户端。
//
// 这是整个程序的地基：微信 iLink 官方机器人通道（即"clawbot"所用的同一套
// 后端协议，bot_type=3）。全部是标准 HTTPS + Bearer token ——
// 不注入进程、不模拟点击、不碰微信客户端内存。
//
// 协议要点（已逐行核对公开实现）：
//   扫码：  GET  {base}/ilink/bot/get_bot_qrcode?bot_type=3
//   轮询：  GET  {base}/ilink/bot/get_qrcode_status?qrcode=...
//   收信：  POST {base}/ilink/bot/getupdates       （长轮询，带游标）
//   发信：  POST {base}/ilink/bot/sendmessage
//   上传：  POST {base}/ilink/bot/getuploadurl
//   读配置：POST {base}/ilink/bot/getconfig
//   输入中：POST {base}/ilink/bot/sendtyping       （"对方正在输入…"）
//
// 本模块是纯协议层：不持有业务状态、不读配置、不写磁盘。

import crypto from 'node:crypto';

/** 通道版本号，随请求上报，便于服务端识别客户端。 */
export const CHANNEL_VERSION = 'wechat-companion/0.1';

/** iLink 服务默认地址（腾讯官方 iLink 机器人平台）。 */
export const DEFAULT_API_BASE = 'https://ilinkai.weixin.qq.com';

/** 媒体 CDN 默认地址。 */
export const DEFAULT_CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';

const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const CONFIG_TIMEOUT_MS = 10_000;
const QR_LOGIN_TIMEOUT_MS = 40_000;

/** 会话/令牌过期：长轮询返回此码时应暂停轮询，等待重新绑定。 */
export const ERR_SESSION_EXPIRED = -14;

/**
 * 业务错误。iLink 在 HTTP 200 的响应体里回报业务失败，有两种形状：
 *   {errcode:-14, errmsg}          —— 会话/令牌过期
 *   {ret:-2, errmsg:"prepare failed"} —— 发送面拒绝
 * 两者都必须当作真错误抛出，否则主动消息会被静默丢弃。
 */
export class WeixinApiError extends Error {
  constructor(endpoint, code, message) {
    super(`iLink ${endpoint} 失败: code=${code} ${message || ''}`.trim());
    this.name = 'WeixinApiError';
    this.endpoint = endpoint;
    this.code = code;
  }
}

/** 生成随机 X-WECHAT-UIN（每次请求不同）。 */
function randomWechatUin() {
  return crypto.randomBytes(4).toString('base64');
}

function buildHeaders(creds, routeTag) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${creds.botToken}`,
    'X-WECHAT-UIN': randomWechatUin(),
  };
  if (routeTag) headers.SKRouteTag = routeTag;
  return headers;
}

/**
 * 发一个 iLink 请求。
 * @param {object} creds  - {botToken, baseUrl?}
 * @param {string} endpoint - 形如 'sendmessage'
 */
async function request(creds, endpoint, body, { timeoutMs = API_TIMEOUT_MS, routeTag, ignoreBusinessError = false } = {}) {
  const baseUrl = creds.baseUrl || DEFAULT_API_BASE;
  const url = `${baseUrl}/ilink/bot/${endpoint}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(creds, routeTag),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`iLink ${endpoint} HTTP ${res.status} ${res.statusText}`);
  }

  const rawText = await res.text();
  if (!rawText.trim()) return {};

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`iLink ${endpoint} 返回非 JSON: ${err.message}`);
  }

  const bizCode = typeof parsed?.errcode === 'number' ? parsed.errcode
    : typeof parsed?.ret === 'number' ? parsed.ret
    : undefined;

  if (!ignoreBusinessError && bizCode !== undefined && bizCode !== 0) {
    throw new WeixinApiError(endpoint, bizCode, parsed.errmsg);
  }
  return parsed;
}

/**
 * 长轮询收取新消息。
 *
 * 超时是**正常情况**（这段时间本来就没有人说话），因此超时返回空结果而不是抛错。
 * 而 errcode -14（会话过期）是长轮询契约的一部分，必须作为数据返回给调用方
 * 去决定暂停多久，所以这里 opt-out 业务错误抛出。
 */
export async function getUpdates(creds, cursor, { timeoutMs = LONG_POLL_TIMEOUT_MS } = {}) {
  try {
    return await request(
      creds,
      'getupdates',
      {
        get_updates_buf: cursor ?? '',
        base_info: { channel_version: CHANNEL_VERSION },
      },
      { timeoutMs: timeoutMs + 5_000, ignoreBusinessError: true },
    );
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { msgs: [], get_updates_buf: cursor };
    }
    throw err;
  }
}

/** 每一条出站消息的幂等标识。 */
function generateClientId() {
  return `wc-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * 发送一条消息（可含多个 item：文字/图片/文件…）。
 * @param {Array} items - 形如 [{type:1, text_item:{text}}]
 */
export async function sendMessage(creds, toUserId, items, contextToken) {
  const clientId = generateClientId();
  await request(creds, 'sendmessage', {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId,
      message_type: 2,   // BOT
      message_state: 2,  // FINISH
      item_list: items.length > 0 ? items : undefined,
      context_token: contextToken || undefined,
    },
    base_info: { channel_version: CHANNEL_VERSION },
  });
  return { clientId };
}

/** 发送纯文本。 */
export async function sendTextMessage(creds, toUserId, text, contextToken) {
  return sendMessage(creds, toUserId, [{ type: 1, text_item: { text } }], contextToken);
}

/**
 * 申请媒体上传地址。返回的 upload_param 用于向 CDN 上传。
 */
export async function getUploadUrl(creds, params) {
  return request(creds, 'getuploadurl', {
    filekey: params.filekey,
    media_type: params.media_type,
    to_user_id: params.to_user_id,
    rawsize: params.rawsize,
    rawfilemd5: params.rawfilemd5,
    filesize: params.filesize,
    no_need_thumb: params.no_need_thumb,
    aeskey: params.aeskey,
  });
}

/**
 * 读取通道配置（含 typing_ticket，用于发送"正在输入"）。
 */
export async function getConfig(creds, ilinkUserId, contextToken) {
  return request(
    creds,
    'getconfig',
    {
      ilink_user_id: ilinkUserId,
      context_token: contextToken,
      base_info: { channel_version: CHANNEL_VERSION },
    },
    { timeoutMs: CONFIG_TIMEOUT_MS },
  );
}

/**
 * 发送"正在输入"状态。
 *
 * 这是让"她"更像真人的关键之一 —— 真人打字时微信会显示"对方正在输入…"。
 * 属于尽力而为：失败不抛错，绝不影响真正的消息发送。
 *
 * @param {number} status - 1 开始输入，2 停止输入
 */
export async function sendTyping(creds, ilinkUserId, typingTicket, status) {
  try {
    await request(
      creds,
      'sendtyping',
      {
        ilink_user_id: ilinkUserId,
        typing_ticket: typingTicket,
        status,
        base_info: { channel_version: CHANNEL_VERSION },
      },
      { timeoutMs: CONFIG_TIMEOUT_MS },
    );
    return true;
  } catch {
    return false; // 尽力而为
  }
}

/**
 * 开始扫码登录：取二维码。
 * 同时支持 GET 与 POST —— 不同服务端版本对方法的容忍度不同，POST 不改变语义。
 */
export async function startLoginQr({ baseUrl = DEFAULT_API_BASE } = {}) {
  const url = `${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bot_type: 3, base_info: { channel_version: CHANNEL_VERSION } }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`获取登录二维码失败: HTTP ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
  }
  return res.json();
}

/** 轮询扫码状态：等待扫码 → 待输入配对码 → 成功拿到 bot_token。 */
export async function pollLoginQrStatus(qrcode, { baseUrl = DEFAULT_API_BASE } = {}) {
  const url = `${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(QR_LOGIN_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`轮询扫码状态失败: HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}
