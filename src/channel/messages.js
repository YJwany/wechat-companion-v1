// 入站消息解析：把 iLink 原始 item_list 翻译成"她"能理解的语义结构。
//
// 设计原则：解析层只做翻译，不做业务判断。拿不准的类型显式标为 unknown，
// 绝不静默丢弃 —— 否则她会对着一句话发呆而日志里什么都看不到。

/** item.type → 语义标签。 */
export const ITEM_TYPE = {
  1: 'text',
  2: 'image',
  3: 'voice',
  4: 'file',
  5: 'video',
};

/**
 * 从一条 iLink 消息里抽取正文文本。
 * 图片/文件等没有文字的媒体，返回可读占位（供提示词里描述"对方发了什么"）。
 */
export function describeItem(item) {
  switch (item.type) {
    case 1: {
      const text = item.text_item?.text;
      return typeof text === 'string' ? text : '';
    }
    case 2: return '[图片]';
    case 3: return '[语音]';
    case 4: {
      const name = item.file_item?.file_name;
      return name ? `[文件: ${name}]` : '[文件]';
    }
    case 5: return '[视频]';
    default: return `[未知消息类型 ${item.type}]`;
  }
}

/**
 * 把一条原始消息归一化为内部结构。
 *
 * @param {object} raw - iLink getupdates 返回的单条 msg
 * @returns {{fromUserId, toUserId, contextToken, clientId, messageType, items, text, kinds, raw}}
 */
export function normalizeMessage(raw) {
  const items = Array.isArray(raw?.item_list) ? raw.item_list : [];
  const kinds = items.map((it) => ITEM_TYPE[it.type] ?? `unknown:${it.type}`);
  const text = items.map(describeItem).filter(Boolean).join('\n');

  return {
    fromUserId: raw?.from_user_id ?? '',
    toUserId: raw?.to_user_id ?? '',
    contextToken: raw?.context_token ?? '',
    clientId: raw?.client_id ?? '',
    messageType: raw?.message_type,
    items,
    kinds,
    text,
    raw,
  };
}

/**
 * 从一批更新里筛出"真正的用户消息"。
 *
 * 通道会回传我们自己的出站消息回执，以及 message_type 非普通用户消息的
 * 系统事件，这些都不是"对方说的话"，必须排除，否则她会自己回复自己。
 */
export function extractUserMessages(updates) {
  const msgs = Array.isArray(updates?.msgs) ? updates.msgs : [];
  const out = [];
  for (const raw of msgs) {
    // message_type: 1 = 用户, 2 = 机器人。只处理用户发来的。
    if (raw?.message_type !== undefined && raw.message_type !== 1) continue;
    // 没有正文且没有可识别 item 的空消息直接跳过。
    if (!Array.isArray(raw?.item_list) || raw.item_list.length === 0) continue;

    const msg = normalizeMessage(raw);
    if (!msg.fromUserId) continue;
    // 出站消息的 from_user_id 为空，to_user_id 才是对方 —— 反向的不要。
    if (msg.fromUserId === msg.toUserId) continue;
    out.push(msg);
  }
  return out;
}
