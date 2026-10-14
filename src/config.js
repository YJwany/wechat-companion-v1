// 配置与路径：所有数据都落在项目文件夹内，便于整体迁移到 D 盘或云服务器。
//
// 约定：项目根 = 本文件所在目录的上两级（src/config.js → 项目根）。
// 迁移时整目录拷贝即可，不依赖任何用户级路径或注册表。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 数据目录。默认就是项目里的 `data/`，整个文件夹拷走就能跑。
 *
 * 但可以被 `COMPANION_DATA_DIR` 指到别处 —— 这是给**测试**用的：
 * 测试会读写 state.json，如果她和测试同时开着，两边会抢同一个文件。
 * 真出过问题：测试刚清掉的假数据，被服务端内存里的旧状态又写了回来，
 * 看起来像"清理没生效"，其实是两个进程在抢。
 */
export const DATA_DIR = process.env.COMPANION_DATA_DIR
  ? path.resolve(process.env.COMPANION_DATA_DIR)
  : path.join(ROOT_DIR, 'data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const INBOX_DIR = path.join(DATA_DIR, 'inbox');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const STATE_FILE = path.join(DATA_DIR, 'state.json');

/** 默认配置。所有可调项集中在此，后台页面按此渲染。 */
export const DEFAULT_CONFIG = {
  // ── 通道 ──
  channel: {
    // iLink 服务地址；一般不需要改
    apiBase: 'https://ilinkai.weixin.qq.com',
    // 绑定后由登录流程写入，不要手改
    botToken: '',
    ilinkUserId: '',
    boundAt: '',
  },

  // ── 模型 ──
  // 先用免费/低价模型跑通，换付费只改这里，不动代码。
  brain: {
    provider: 'siliconflow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    temperature: 0.9,
    maxTokens: 800,
  },

  // ── 世界引擎（每晚替她写"明天"）──
  // 设计上要求独立模型槽位：它决定她的人生剧本，不该跟对话互相干扰。
  // 未配置时自动降级为复用 brain，保证永远跑得起来。
  world: {
    enabled: true,
    baseUrl: '',
    apiKey: '',
    model: '',
    weatherReal: true,
    city: '',
  },

  // ── 识图（让她"看得见"你发的图片）──
  // 独立槽位：对话模型不一定支持多模态。留空则回落对话模型 ——
  // 若主模型本身能看图，直接就能用；不能的话配一个 Qwen2.5-VL 之类即可。
  vision: {
    enabled: true,
    baseUrl: '',
    apiKey: '',
    model: '',
  },

  // ── 她是谁 ──
  persona: {
    name: '小满',
    gender: 'female',
    age: 24,
    city: '杭州',
    job: '在一家独立书店做店员',
    background: '喜欢在旧书里夹东西，会为了一个句子坐一下午。养了一只叫团子的橘猫。',
    mbti: 'INFP',
    // 说话风格：会直接进提示词
    speechStyle: '语速不快，喜欢用短句。偶尔会突然想起一件事就岔开话题。不太用感叹号。',
    interests: ['旧书', '手冲咖啡', '猫', '下雨天', '民谣'],
    // emoji 使用比例 0-100
    emojiRate: 20,
  },

  // ── 相处 ──
  behavior: {
    // human 拟人 | instant 秒回 | slow 慢热
    replySpeed: 'human',
    // 一条回复最多拆成几条发
    chunkMax: 3,
    // 打字延迟开关（会用 sendtyping 显示"正在输入"）
    typingIndicator: true,
    // 手滑打错字概率 0-10
    typoRate: 0,
    // 只在名单内的人回复；留空 = 回复所有人
    allowedPeers: [],
    // 是否回复所有陌生人
    replyToAll: true,
    // 安静时段（她睡觉时一条主动消息都不发）
    quietHours: { start: '23:30', end: '07:30' },
    // 每日主动消息上限
    proactiveDailyLimit: 4,
    // 全局急停
    paused: false,
    // 发前常识自检：发现"凌晨三点在银行"这类穿帮就让她改口。
    // 本地先查（免费），只有查出问题才多调一次模型 —— 所以开着也不贵。
    commonSenseCheck: true,
  },

  // ── 记忆 ──
  memory: {
    enabled: true,
    // 每次注入她脑中的记忆条数
    topK: 6,
    // 最多保留多少条记忆
    maxEntries: 2000,
  },

  // ── 主动消息 ──
  proactive: {
    enabled: true,
    morningGreeting: true,
    nightGreeting: true,
    // 太久没聊会想他
    longing: true,
    longingAfterHours: 20,
  },

  // ── 朋友圈（内容私聊下发，不做真实发布）──
  moments: {
    enabled: true,
    // 每周最多"想发"几次
    weeklyPosts: 2,
    // 自动挑选时间发给你
    autoSendTo: '',
  },

  // ── 系统 ──
  system: {
    logLevel: 'info',
    backupKeepDays: 7,
    // 控制台端口
    consolePort: 43121,
  },
};

/** 深合并：以默认值为骨架，用用户配置覆盖。对象递归，数组整体替换。 */
function deepMerge(base, override) {
  if (override === undefined) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  if (base && override && typeof base === 'object' && typeof override === 'object') {
    const out = { ...base };
    for (const key of Object.keys(override)) {
      out[key] = deepMerge(base[key], override[key]);
    }
    return out;
  }
  return override;
}

/** 确保所有数据目录存在。 */
/**
 * 解析识图槽位：优先独立配置，留空则回落对话模型。
 *
 * 与参考实现同一套回落规则。注意**世界引擎刻意不回落** ——
 * 它决定她的人生剧本，跟对话共用一个槽位会互相干扰。
 *
 * @returns {{baseUrl, apiKey, model, degraded}} degraded 表示正在复用对话模型
 */
export function resolveVisionSlot(cfg) {
  const v = cfg?.vision ?? {};
  const b = cfg?.brain ?? {};
  return {
    baseUrl: v.baseUrl || b.baseUrl || '',
    apiKey: v.apiKey || b.apiKey || '',
    model: v.model || b.model || '',
    degraded: !v.model,
  };
}

export function ensureDirs() {  for (const dir of [DATA_DIR, MEDIA_DIR, INBOX_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 读取配置（与默认值合并后返回）。 */
export function loadConfig() {
  ensureDirs();
  let user = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (err) {
      throw new Error(`配置文件解析失败 ${CONFIG_FILE}: ${err.message}`);
    }
  }
  return deepMerge(DEFAULT_CONFIG, user);
}

/** 写入配置（原子替换，避免写一半断电留下坏文件）。 */
export function saveConfig(cfg) {
  ensureDirs();
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
}

/**
 * 把配置里"只存不用"的键挡掉：只保留 DEFAULT_CONFIG 里存在的键。
 * 防止后台页面写进一个永远不会生效的值，变成黑盒。
 */
export function sanitizeConfig(input, template = DEFAULT_CONFIG) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const key of Object.keys(template)) {
    if (!(key in input)) continue;
    const tpl = template[key];
    const val = input[key];
    if (tpl && typeof tpl === 'object' && !Array.isArray(tpl) && val && typeof val === 'object' && !Array.isArray(val)) {
      out[key] = sanitizeConfig(val, tpl);
    } else {
      out[key] = val;
    }
  }
  return out;
}

/** 原子写 JSON（通用小工具，store 与 state 共用）。 */
export function writeJsonAtomic(file, value) {
  ensureDirs();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 读 JSON，损坏时返回兜底值而不是抛错（她的数据不该因为一个坏文件就全挂）。 */
export function readJsonSafe(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
