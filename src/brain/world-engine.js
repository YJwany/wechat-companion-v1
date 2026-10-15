// 世界引擎：每晚替她写下"明天"。
//
// 这是她不像工具人的关键 —— 不是等用户开口她才存在，而是她有自己的日子
// 要过。每晚跑一次独立模型调用，产出一份"明天的人生剧本"。
//
// 设计铁律（借鉴成熟实现的血泪结论）：世界引擎用**独立模型槽位**，
// 不与对话接口共用。理由：这份产出决定她的人设一致性，如果跟闲聊抢同一个
// 上下文/配额，会互相污染。未配置时降级复用对话模型 —— 保证永远跑得起来，
// 但要如实标注降级了。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, writeJsonAtomic } from '../config.js';
import { chat } from './client.js';

const WORLD_FILE = path.join(DATA_DIR, 'world.json');
const DIARY_DIR = path.join(DATA_DIR, 'diary');

/** 稳定的社交圈编制（最多 6 人）—— 她生活里的人，不许每次编新的。 */
const DEFAULT_NPC_POOL = [
  { name: '阿宁', relation: '大学室友' },
  { name: '陈姐', relation: '店里的同事' },
  { name: '团子', relation: '养的橘猫' },
  { name: '老周', relation: '常来买书的客人' },
  { name: '小满妈', relation: '妈妈' },
];

export class WorldEngine {
  constructor({ cfg, memory }) {
    this.cfg = cfg;
    this.memory = memory;
    this.state = this.load();
  }

  load() {
    try {
      if (fs.existsSync(WORLD_FILE)) return JSON.parse(fs.readFileSync(WORLD_FILE, 'utf8'));
    } catch { /* 坏了就当没有 */ }
    return { version: 1, scripts: {} };
  }

  save() {
    writeJsonAtomic(WORLD_FILE, this.state);
  }

  /** 取某一天（YYYY-MM-DD）的剧本。 */
  scriptFor(dateKey) {
    return this.state.scripts?.[dateKey] ?? null;
  }

  /** 判断今晚是否需要生成明天的剧本。 */
  shouldGenerate(now = new Date()) {
    if (!this.cfg.world?.enabled) return false;
    const tomorrow = dateKey(new Date(now.getTime() + 86_400_000));
    if (this.scriptFor(tomorrow)) return false; // 已经写过了

    // 只在她的睡眠窗口内生成
    const minutes = now.getHours() * 60 + now.getMinutes();
    const sleepMin = toMinutes(this.cfg.behavior?.quietHours?.start ?? '23:30');
    // 入睡后到次日 5 点之间都可以跑
    return minutes >= sleepMin || minutes < 5 * 60;
  }

  /**
   * 跑一次世界引擎，为明天写剧本。
   *
   * @param {Date} now
   * @param {object} opts
   * @param {string} opts.forDate 指定为哪一天写（默认明天）。
   *   手动触发时通常希望**今天就生效**，否则今天她仍然没有生活可分享 ——
   *   这是实测发现的设计缺陷：当晚跑到的是"明天"，而当天一直是空的。
   * @returns {Promise<{ok: boolean, reason?: string, script?: object}>}
   */
  async generateForTomorrow(now = new Date(), { forDate } = {}) {
    const target = forDate ?? dateKey(new Date(now.getTime() + 86_400_000));

    const slot = this.resolveSlot();
    if (!slot.baseUrl || !slot.model) {
      return { ok: false, reason: '世界引擎没有可用的模型（未配置且无法降级）' };
    }

    const persona = this.cfg.persona;
    const weather = this.cfg.world.weatherReal
      ? await fetchWeather(this.cfg.world.city || persona.city)
      : null;

    // 如果今天已有剧本，把它作为"昨天"喂进去保证延续性
    const yesterday = this.scriptFor(dateKey(now));
    const prompt = buildWorldPrompt({ persona, weather, yesterday, targetDate: target });

    let raw;
    try {
      raw = await chat(
        // 预算必须同时装下"思考"和"正文"：实测一次思考约 9000 字（≈4500 token），
        // 加上 JSON 正文，completion 约 7000 token。给少了思考就把额度吃光，
        // 正文挤不出来 —— 看起来像"返回的不是合法 JSON"。给足 16000 留余量。
        { ...slot, temperature: 1.0, maxTokens: 16000 },
        [
          { role: 'system', content: '你是一个编剧。你只为给定的角色写下"这一天"，不评论、不解说、不破坏角色。只输出 JSON。' },
          { role: 'user', content: prompt },
        ],
        { jsonMode: true, timeoutMs: 180_000 },
      );
    } catch (err) {
      return { ok: false, reason: `世界引擎调用失败: ${err.message}` };
    }

    let parsed;
    try {
      parsed = JSON.parse(extractJson(raw));
    } catch (err) {
      return { ok: false, reason: `世界引擎返回的不是合法 JSON: ${err.message}` };
    }

    const script = {
      forDate: target,
      generatedAt: new Date().toISOString(),
      degraded: slot.degraded === true,
      diary: String(parsed.diary ?? '').trim(),
      wakeAt: normalizeTime(parsed.wake_at, '07:30'),
      sleepAt: normalizeTime(parsed.sleep_at, '23:30'),
      mood: String(parsed.mood ?? '平静').trim(),
      focus: String(parsed.focus ?? '').trim(),
      flow: String(parsed.flow ?? '').trim(),
      thoughts: String(parsed.thoughts ?? '').trim(),
      secret: String(parsed.secret ?? '').trim(),
      weather: weather ? `${weather.desc} ${weather.temp}℃` : String(parsed.weather ?? '').trim(),
      npcs: mergeNpcs(normalizeNpcs(parsed.npcs), yesterday?.npcs),
    };

    this.state.scripts[target] = script;
    this.pruneScripts();
    this.save();

    // 日记按天留档，永久保存，记事本能打开
    fs.mkdirSync(DIARY_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DIARY_DIR, `${target}.md`),
      `# ${target} · ${persona.name}的日记\n\n生成时间：${script.generatedAt}\n心情：${script.mood}\n天气：${script.weather}\n\n---\n\n${script.diary}\n`,
      'utf8',
    );

    // 生活流水进记忆，聊天时她才能"自然提到今天干了什么"
    if (this.memory && script.flow) {
      this.memory.add(`${persona.name}今天：${script.flow}`, { bucket: 'self', source: 'world' });
    }

    return { ok: true, script };
  }

  /** 解析世界引擎该用哪个模型槽位（独立优先，否则降级复用对话模型）。 */
  resolveSlot() {
    const w = this.cfg.world ?? {};
    const b = this.cfg.brain ?? {};
    if (w.baseUrl && w.model) {
      return { baseUrl: w.baseUrl, apiKey: w.apiKey || b.apiKey, model: w.model, reasoningEffort: w.reasoningEffort || b.reasoningEffort || '', degraded: false };
    }
    // 降级：复用对话模型。功能完整，但违反"独立槽位"的设计意图，如实标注。
    return { baseUrl: b.baseUrl, apiKey: b.apiKey, model: b.model, reasoningEffort: b.reasoningEffort || '', degraded: true };
  }

  /** 只保留最近 60 天剧本，避免无限增长。 */
  pruneScripts() {
    const keys = Object.keys(this.state.scripts ?? {}).sort();
    if (keys.length <= 60) return;
    for (const k of keys.slice(0, keys.length - 60)) delete this.state.scripts[k];
  }

  /** 读日记列表（后台用）。 */
  listDiaries(limit = 30) {
    if (!fs.existsSync(DIARY_DIR)) return [];
    return fs.readdirSync(DIARY_DIR)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, limit)
      .map((f) => ({
        date: f.replace('.md', ''),
        content: fs.readFileSync(path.join(DIARY_DIR, f), 'utf8'),
      }));
  }
}

/** 组装世界引擎的提示词。 */
function buildWorldPrompt({ persona, weather, yesterday, targetDate }) {
  const dateLine = targetDate ? `【要为哪一天写】${targetDate}\n` : '';
  // 昨天的人名要原样带过来 —— 不然模型每天给猫重新起名（橘仔→嘟嘟）
  const prevNpcs = (yesterday?.npcs ?? []).filter((n) => n?.name);
  const npcLine = prevNpcs.length
    ? `\n【她生活里的人（**必须原样沿用，名字一个字都不能改，尤其是宠物**）】\n${prevNpcs.map((n) => `${n.name}（${n.relation}）`).join('、')}\n`
    : '';
  return `为角色「${persona.name}」写下这一天。

${dateLine}【角色】
姓名：${persona.name}
年龄：${persona.age}
城市：${persona.city}
职业：${persona.job}
背景：${persona.background}
性格类型：${persona.mbti}
说话风格：${persona.speechStyle}
兴趣：${(persona.interests ?? []).join('、')}
${weather ? `明天真实天气：${weather.desc}，${weather.temp}℃，${weather.city}` : '（天气未知，请你合理编一个）'}
${yesterday ? `\n【今天她过的一天】\n作息：${yesterday.wakeAt} 起 ${yesterday.sleepAt} 睡\n心情：${yesterday.mood}\n做了什么：${yesterday.flow}\n${npcLine}\n明天必须与今天延续（昨晚没睡好→明天没精神；今天生病→明天最多是好转）。` : ''}

【输出要求】
只输出一个 JSON 对象，不要任何其他文字。字段如下：

{
  "diary": "她今晚写的私人日记，第一人称，150-250字。写今天真实发生的小事、心里的想法。像真人写日记，不要总结人生、不要抒情过度、不要提到任何 AI 或程序。",
  "wake_at": "明天几点起床，HH:MM。工作日/上班日要早；她若作息随性可以睡到 10:00。",
  "sleep_at": "明天几点睡，HH:MM。通常在 22:30-01:30 之间。",
  "mood": "明天的心情，4-8 个字。例如：有点闷、莫名开心、平静",
  "focus": "她明天会一直想着的一件事，10-20 字。要具体。例如：书店要进的那批旧书",
  "flow": "明天她干了什么，40-80 字。必须与职业和城市相符，必须具体。例如：上午在店里整理新到的旧书，下午来了个老客人聊了半小时。",
  "thoughts": "她心里转着的念头，30-50 字。可以是没头没尾的。",
  "secret": "她一个小秘密或小心事，20-40 字。她不会主动说，只有气氛合适才会漏一点。",
  "weather": "天气描述，5-12 字。",
  "npcs": [{"name": "人名", "relation": "与她的关系"}]
}

【硬规则】
- npcs 是她生活里的人，最多 6 个。**如果上面给了"她生活里的人"，名字必须一字不改地沿用（尤其是宠物），绝对不许换名字**；只能在此基础上少量新增。
- "flow" 里的地点和活动必须符合她的城市、职业和作息，不能出现她身份不该有的场景。
- 她不能用手机以外的方式联系别人（不能说"我发朋友圈""我打电话"）。
- 日记里不要出现"AI""模型""程序""生成"这类词，她不知道自己是被写出来的。`;
}

/** 真实天气（Open-Meteo，免费无需 key；失败就静默降级让她自己编）。 */
async function fetchWeather(city) {
  if (!city) return null;
  try {
    const geo = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`,
      { signal: AbortSignal.timeout(8000) },
    ).then((r) => r.json());
    const loc = geo?.results?.[0];
    if (!loc) return null;

    const wx = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto`,
      { signal: AbortSignal.timeout(8000) },
    ).then((r) => r.json());

    const code = wx?.daily?.weather_code?.[0];
    const tmax = wx?.daily?.temperature_2m_max?.[0];
    const tmin = wx?.daily?.temperature_2m_min?.[0];
    if (code === undefined) return null;

    return {
      city: loc.name,
      desc: WEATHER_CODE[code] ?? '多云',
      temp: `${Math.round(tmin)}~${Math.round(tmax)}`,
    };
  } catch {
    return null;
  }
}

const WEATHER_CODE = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '有雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  71: '小雪', 73: '中雪', 75: '大雪',
  80: '阵雨', 81: '强阵雨', 82: '暴雨',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴',
};

/**
 * 从模型回复里抠出 JSON。
 *
 * 推理模型（deepseek-v4.1-flash 这类）经常在 JSON 前后夹一大段"思考"，
 * 而且爱用中文全角引号 —— 这两件事都会让 JSON.parse 直接失败。
 * 所以：先归一化引号，再扫描所有"括号配平"的候选，返回第一个能解析的。
 */
function extractJson(text) {
  const s = String(text ?? '')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const hit = firstParsableJson(fenced[1]);
    if (hit) return hit;
  }
  const hit = firstParsableJson(s);
  if (hit) return hit;
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) return s.slice(start, end + 1);
  return s;
}

/** 扫描字符串里所有"括号配平"的 {…} 片段，返回第一个能被 JSON.parse 的。 */
function firstParsableJson(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const cand = s.slice(i, j + 1);
          try { JSON.parse(cand); return cand; } catch { /* 试下一个起点 */ }
          break;
        }
      }
    }
  }
  return null;
}

function normalizeTime(value, fallback) {
  const m = String(value ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  const h = Math.min(23, Math.max(0, Number(m[1])));
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/**
 * 把"模型今天给的人"和"昨天的人"合并。
 *
 * 为什么必须在代码层兜底：提示词里写了"不许改名"是**软约束**，模型经常不听 ——
 * 实测猫从「橘仔」变成「嘟嘟」。真人不会把自家的猫改名，所以这里硬来：
 *   - 以昨天的人为底，一个都不丢（"不能遗忘"）
 *   - 同名的跳过
 *   - 同类角色的（比如她的猫）不新增，避免"同一只猫出现两个名字"
 *   - 允许真正的新人加入，总数不超过 6
 */
function mergeNpcs(fresh, prev) {
  const prevList = Array.isArray(prev) ? prev.filter((n) => n?.name) : [];
  if (!prevList.length) return fresh;

  const out = prevList.map((n) => ({ name: n.name, relation: n.relation }));
  const petLike = (s) => /猫|狗|宠物|柯基|橘|狸花|仓鼠|兔|鸟/.test(String(s ?? ''));
  for (const n of fresh) {
    if (!n?.name) continue;
    if (out.some((o) => o.name === n.name)) continue;
    if (petLike(n.relation) && out.some((o) => petLike(o.relation))) continue;
    if (out.length >= 6) break;
    out.push({ name: n.name, relation: n.relation });
  }
  return out;
}

function normalizeNpcs(list) {
  if (!Array.isArray(list) || !list.length) return DEFAULT_NPC_POOL;
  const seen = new Set();
  const out = [];
  for (const n of list) {
    const name = String(n?.name ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, relation: String(n?.relation ?? '').trim() || '认识的人' });
    if (out.length >= 6) break;
  }
  return out.length ? out : DEFAULT_NPC_POOL;
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
